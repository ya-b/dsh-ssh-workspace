/**
 * Per-host runtime pool: one daemon-backed `ctx.ssh` substitute and one
 * instance of each official SSH provider per host, created lazily and shared
 * by every workspace that lives on that host. The daemon archive is installed
 * once per (host, state directory, archive digest); the transport is opened on
 * first use and never re-installed on reconnect.
 * @module @dsh-ssh-workspace/mount/hosts
 */

import { Context, type Fiber } from '@deepseek-ai/cordis'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import { SshSandboxProvider } from '@deepseek-ai/dsh-sandbox-ssh'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'
import { DaemonSshConnection } from '@dsh-ssh-workspace/providers'
import { installDaemonArchive } from '@dsh-ssh-workspace/install'
import { RemoteWorkspaceTransport, type RemoteWorkspaceConfig } from '@dsh-ssh-workspace/transport'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

/** Deployment settings shared by every host runtime. */
export interface HostsConfig {
  daemonDir: string
  node: string
  requestTimeoutMs: number
  reconnectBaseMs: number
  reconnectMaxMs: number
  controlDir?: string
  maxFrameBytes?: number
  maxPending?: number
  install: boolean
  autoUpgrade: boolean
  daemonArchive?: string
}

/** One live host: transport plus the official provider family bound to it. */
export interface HostRuntime {
  readonly host: string
  readonly transport: RemoteWorkspaceTransport
  readonly connection: DaemonSshConnection
  readonly fs: SshFileSystem
  readonly subprocess: SshSubprocessRuntime
  readonly sandbox: SshSandboxProvider
  /** Handshake settled (daemon installed and reachable). */
  ready: Promise<void>
  /** Allow one more remote root in the daemon's workspace whitelist. */
  allow(path: string): Promise<void>
}

/** One host's official provider family, owned by its own plugin fiber. */
interface HostProviderFamily {
  connection: DaemonSshConnection
  fs: SshFileSystem
  subprocess: SshSubprocessRuntime
  sandbox: SshSandboxProvider
}

/** Installs in flight or finished, keyed by host, state directory, and digest. */
const installs = new Map<string, Promise<void>>()

/** Digest of the archive shipped beside this package, computed once. */
let archiveDigest: Promise<{ path: string, sha256: string } | undefined> | undefined

/** Locate and hash the shipped daemon archive; undefined when none is shipped. */
function shippedArchive(): Promise<{ path: string, sha256: string } | undefined> {
  archiveDigest ??= (async () => {
    const path = fileURLToPath(new URL('../dist/daemon.tar.gz', import.meta.url))
    if (!existsSync(path)) return undefined
    return { path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }
  })()
  return archiveDigest
}

/** Read the archive bytes once; the same digest is reused for every host. */
const archives = new Map<string, Promise<Buffer>>()
function readArchive(path: string): Promise<Buffer> {
  let pending = archives.get(path)
  if (pending === undefined) {
    pending = readFile(path) as Promise<Buffer>
    archives.set(path, pending)
  }
  return pending
}

/** The runtime pool. */
export class RemoteHosts {
  private readonly runtimes = new Map<string, HostRuntime>()
  private readonly fibers = new Map<string, Fiber>()

  private readonly ctx: Context
  private readonly config: HostsConfig

  /**
   * @param ctx - host plugin context; child scopes inherit its services.
   * @param config - deployment settings.
   */
  constructor(ctx: Context, config: HostsConfig) {
    this.ctx = ctx
    this.config = config
  }

  /** The live runtime of a host, when it has been created. */
  peek(host: string): HostRuntime | undefined {
    return this.runtimes.get(host)
  }

  /** Handshake promise of a live runtime, for callers that may await. */
  ready(host: string): Promise<void> | undefined {
    return this.runtimes.get(host)?.ready
  }

  /** Every host with a live runtime, in creation order. */
  hosts(): string[] {
    return [...this.runtimes.keys()]
  }

  /**
   * The runtime of one host, creating it on first use. Creation itself is
   * synchronous; the provider family binds one microtask later inside its own
   * fiber, and installation and the handshake run behind {@link HostRuntime.ready}.
   * Reading the provider getters before `ready` settles throws by design, so
   * await `ready` first; every RPC additionally awaits the transport's own open.
   * @param host - OpenSSH host alias.
   */
  pair(host: string): HostRuntime {
    let runtime = this.runtimes.get(host)
    if (runtime === undefined) {
      runtime = this.create(host)
      this.runtimes.set(host, runtime)
    }
    return runtime
  }

  /** Dispose every transport and provider fiber; remote daemons keep running by design. */
  async dispose(): Promise<void> {
    const closing = [...this.runtimes.values()]
    const fibers = [...this.fibers.values()]
    this.runtimes.clear()
    this.fibers.clear()
    await Promise.allSettled([
      ...closing.map(runtime => runtime.transport.dispose()),
      ...fibers.map(fiber => fiber.dispose()),
    ])
  }

  /**
   * Build the provider family inside a plugin fiber of its own, then install
   * the daemon once per archive digest.
   *
   * The family registers services named `ssh`, `fs`, `subprocess` and
   * `sandbox`, which also exist on the root plane (and, in a profile that
   * loads the official SSH plugins, could come from anywhere else). An
   * isolated scope alone does not keep those registrations private:
   * `ctx.isolate` shares the parent fiber, and registration writes into the
   * parent fiber's name-keyed service store — which then shadows the root
   * plane for every context derived from this plugin, with each later host
   * winning for every earlier one. A plugin fiber of its own gives the family
   * a private name-keyed store, so `ctx.fs` resolves to the daemon-backed
   * filesystem inside the family and to the genuine local filesystem
   * everywhere else, no matter how many hosts are paired.
   */
  private create(host: string): HostRuntime {
    const config = this.transportConfig(host)
    const scope = this.ctx.isolate('ssh').isolate('fs').isolate('subprocess').isolate('sandbox')
    const transport = new RemoteWorkspaceTransport(config)
    let family: HostProviderFamily | undefined
    const built = new Promise<HostProviderFamily>((resolve, reject) => {
      let fiber: Fiber
      try {
        fiber = scope.plugin({
          name: `ssh-workspace-host:${host}`,
          apply(hostCtx: Context) {
            try {
              family = {
                connection: new DaemonSshConnection(hostCtx, { transport }),
                fs: new SshFileSystem(hostCtx),
                subprocess: new SshSubprocessRuntime(hostCtx),
                sandbox: new SshSandboxProvider(hostCtx),
              }
              resolve(family)
            } catch (error) {
              reject(error)
            }
          },
        })
      } catch (error) {
        reject(error)
        return
      }
      this.fibers.set(host, fiber)
    })
    const requireFamily = (): HostProviderFamily => {
      if (family === undefined) {
        throw new Error(`remote host '${host}' providers are still starting; await the runtime's ready promise first`)
      }
      return family
    }
    const runtime: HostRuntime = {
      host,
      transport,
      get connection() { return requireFamily().connection },
      get fs() { return requireFamily().fs },
      get subprocess() { return requireFamily().subprocess },
      get sandbox() { return requireFamily().sandbox },
      ready: built.then(() => this.deploy(host, config)).then(() => transport.open()),
      allow: async (path: string) => {
        if (path === '') return
        await transport.request('workspace.allow', { path }, allowSchema, AbortSignal.timeout(config.requestTimeoutMs ?? 30_000))
      },
    }
    const ready = runtime.ready.catch((error: unknown) => {
      this.runtimes.delete(host)
      const fiber = this.fibers.get(host)
      this.fibers.delete(host)
      void fiber?.dispose().catch(() => undefined)
      void transport.dispose().catch(() => undefined)
      throw error
    })
    runtime.ready = ready
    void ready.catch(() => undefined)
    return runtime
  }

  /**
   * One transport configuration for a host. The session workspace is `/`: one
   * transport serves every adopted root on its host, so the handshake must not
   * pin one directory (each adopted root is separately added with
   * `workspace.allow` before use).
   */
  private transportConfig(host: string): RemoteWorkspaceConfig {
    const config = this.config
    return {
      host,
      workspace: '/',
      daemonDir: config.daemonDir,
      node: config.node,
      requestTimeoutMs: config.requestTimeoutMs,
      reconnectBaseMs: config.reconnectBaseMs,
      reconnectMaxMs: config.reconnectMaxMs,
      autoUpgrade: config.autoUpgrade,
      ...(config.controlDir === undefined ? {} : { controlDir: config.controlDir }),
      ...(config.maxFrameBytes === undefined ? {} : { maxFrameBytes: config.maxFrameBytes }),
      ...(config.maxPending === undefined ? {} : { maxPending: config.maxPending }),
    }
  }

  /** Ship the daemon to one host once per archive digest, then reuse it. */
  private async deploy(host: string, config: RemoteWorkspaceConfig): Promise<void> {
    const override = this.config.daemonArchive
    const archive = override === undefined ? undefined : { path: override, sha256: 'override' }
    if (!this.config.install && archive === undefined) return
    const shipped = archive ?? await shippedArchive()
    if (shipped === undefined) {
      throw new Error(
        "remote workspace daemon archive is missing; build it with 'pnpm run archive' in packages/mount "
        + 'or set daemonArchive in the mount settings',
      )
    }
    const key = `${host}\u0000${config.daemonDir}\u0000${shipped.sha256}`
    let pending = installs.get(key)
    if (pending === undefined) {
      pending = readArchive(shipped.path).then(buffer => installDaemonArchive(config, buffer)).catch((error: unknown) => {
        installs.delete(key)
        throw error
      })
      installs.set(key, pending)
    }
    await pending
  }
}

/** Daemon handshake response for `workspace.allow`. */
const allowSchema = z.object({ roots: z.array(z.string()) }).strict()
