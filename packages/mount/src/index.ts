/**
 * rc.2-native remote workspace mounting. The plugin owns three pieces:
 *
 * - a per-host runtime pool of daemon-backed `ctx.ssh` plus the official SSH
 *   provider family (`ssh`, `fs`, `subprocess`, `sandbox` — all upstream code),
 * - root-plane routers that keep the official local providers as fallback and
 *   dispatch each path-, cwd-, or policy-rooted call to the owning machine,
 * - workspace adoption on the official registry: a durable record whose path
 *   is the canonical *remote* directory, with a strict sidecar mapping the
 *   workspace id back to its host.
 *
 * Nothing in the harness is modified; every seam is a runtime patch of an
 * official instance, and the daemon's public surface is exactly what the
 * published SSH providers expect.
 * @module @dsh-ssh-workspace/mount
 */

import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { isAbsolute, join, posix } from 'node:path'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-workspace'
import { RemoteHosts } from './hosts.ts'
import { patchFileSystem, patchSandbox, patchSessionController, patchSubprocess, patchTerminalController } from './patch.ts'
import { adoptRemoteWorkspace, patchRegistry, type RegistryLike } from './registry.ts'
import { RemoteWorkspaceState, type RemoteWorkspaceRecord } from './state.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sshWorkspace: SshWorkspaceMount
  }
}

/** Deployment settings of the mount. */
export interface Config {
  /** Remote daemon state directory; `~/` is expanded by the remote shell. */
  daemonDir?: string
  /** Absolute remote Node executable used to run the daemon. */
  node?: string
  /** Per-request administrative deadline, in milliseconds. */
  requestTimeoutMs?: number
  /** Reconnect backoff base in milliseconds. */
  reconnectBaseMs?: number
  /** Reconnect backoff ceiling in milliseconds. */
  reconnectMaxMs?: number
  /** Local SSH control directory; a temp directory when absent. */
  controlDir?: string
  /** Install the shipped daemon archive on first use of a host. */
  install?: boolean
  /**
   * Replace a remote daemon whose loaded bundle no longer matches the installed
   * one. Only an idle daemon (no live child processes) is replaced, so running
   * commands are never interrupted.
   */
  autoUpgrade?: boolean
  /** Override the shipped daemon archive path, for development. */
  daemonArchive?: string
  /** Attribution sidecar path; defaults under the harness home's storages. */
  statePath?: string
}

type ResolvedConfig = {
  daemonDir: string
  node: string
  requestTimeoutMs: number
  reconnectBaseMs: number
  reconnectMaxMs: number
  controlDir?: string
  install: boolean
  autoUpgrade: boolean
  daemonArchive?: string
  maxFrameBytes?: number
  maxPending?: number
  statePath?: string
}

/** One directory child returned to the picker. */
export interface BrowseEntry {
  name: string
  path: string
  hidden: boolean
}

/** One directory level returned to the picker. */
export interface BrowseListing {
  /** Canonical spelling of the listed directory. */
  path: string
  /** Parent directory, absent at a filesystem root. */
  parent?: string
  entries: BrowseEntry[]
}

/** View of one adopted remote workspace. */
export interface AdoptedWorkspace {
  workspaceId: string
  host: string
  path: string
  title: string
}

/** Default attribution sidecar under the harness home. */
function defaultStatePath(): string {
  const home = process.env.DSH_HOME === undefined || process.env.DSH_HOME === '' ? join(homedir(), '.dsh') : process.env.DSH_HOME
  return join(home, 'storages', 'ssh-workspaces.json')
}

/**
 * The plugin service. Loads as `ctx.sshWorkspace`; its `adopt`/`browse`
 * methods are what the HTTP picker half consumes.
 */
export class SshWorkspaceMount extends Service {
  static Config = schema.object({
    daemonDir: schema.string().default('~/.dsh-workspace'),
    node: schema.string().default('node'),
    requestTimeoutMs: schema.number().min(1).max(2_147_483_647).default(30_000),
    reconnectBaseMs: schema.number().min(10).max(60_000).default(250),
    reconnectMaxMs: schema.number().min(100).max(600_000).default(15_000),
    controlDir: schema.string(),
    install: schema.boolean().default(true),
    autoUpgrade: schema.boolean().default(true),
    daemonArchive: schema.string(),
    maxFrameBytes: schema.number(),
    maxPending: schema.number(),
    statePath: schema.string(),
  })

  static inject = ['fs', 'subprocess', 'sandbox', 'workspaceRegistry']

  private readonly hosts: RemoteHosts
  private readonly state: RemoteWorkspaceState

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sshWorkspace')
    const resolved = SshWorkspaceMount.Config({
      daemonDir: '~/.dsh-workspace', node: 'node', requestTimeoutMs: 30_000,
      reconnectBaseMs: 250, reconnectMaxMs: 15_000, install: true, autoUpgrade: true, ...config,
    }) as unknown as ResolvedConfig
    this.state = new RemoteWorkspaceState(resolved.statePath === undefined || resolved.statePath === '' ? defaultStatePath() : resolved.statePath)
    this.hosts = new RemoteHosts(ctx, {
      daemonDir: resolved.daemonDir,
      node: resolved.node,
      requestTimeoutMs: resolved.requestTimeoutMs,
      reconnectBaseMs: resolved.reconnectBaseMs,
      reconnectMaxMs: resolved.reconnectMaxMs,
      install: resolved.install,
      autoUpgrade: resolved.autoUpgrade,
      ...(resolved.controlDir === undefined ? {} : { controlDir: resolved.controlDir }),
      ...(resolved.daemonArchive === undefined ? {} : { daemonArchive: resolved.daemonArchive }),
      ...(resolved.maxFrameBytes === undefined ? {} : { maxFrameBytes: resolved.maxFrameBytes }),
      ...(resolved.maxPending === undefined ? {} : { maxPending: resolved.maxPending }),
    })
  }

  /** Wire the routers, then reconnect every host a previous run adopted. */
  protected async [Service.init](): Promise<void> {
    await this.state.list()
    patchFileSystem(this.ctx, this.ctx.fs, this.hosts, this.state)
    patchSubprocess(this.ctx, this.ctx.subprocess, this.hosts, this.state)
    patchSandbox(this.ctx.sandbox, this.hosts, this.state)
    patchRegistry(this.ctx, this.ctx.workspaceRegistry as unknown as RegistryLike, this.state)
    this.ctx.inject(['terminalController'], (termCtx) => {
      patchTerminalController((termCtx as unknown as { terminalController: { execution(agent: { session?: { header?: { cwd?: string } } }): object } }).terminalController, this.hosts, this.state)
    })
    this.ctx.inject(['sessionController'], (sessionCtx) => {
      patchSessionController((sessionCtx as unknown as { sessionController: Parameters<typeof patchSessionController>[0] }).sessionController, this.hosts, this.state)
    })
    this.ctx.effect(() => () => { void this.hosts.dispose() }, 'ssh-workspace: host transports')
    const hosts = new Set(this.state.snapshot().map(record => record.host))
    for (const host of hosts) {
      this.hosts.pair(host).ready.catch((error: unknown) => {
        this.ctx.logger.warn(`ssh-workspace: host '${host}' is not reachable yet: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }

  /**
   * Adopt one remote directory as a workspace on its host.
   * @param input - host alias, remote directory, and optional initial title.
   * @returns the adopted workspace view.
   */
  async adopt(input: { host: string, path: string, title?: string }): Promise<AdoptedWorkspace> {
    const entity = await adoptRemoteWorkspace(this.ctx.workspaceRegistry as unknown as RegistryLike, this.hosts, this.state, input)
    return { workspaceId: String(entity.id), host: input.host, path: entity.path, title: entity.title }
  }

  /**
   * List one directory level on one machine: the local harness machine for
   * `null`, the owning daemon-backed provider for an alias.
   * @param host - OpenSSH alias, or null/empty for the harness machine.
   * @param path - absolute directory path in the target machine's namespace.
   */
  async browse(host: string | null, path: string): Promise<BrowseListing> {
    const remote = host !== null && host !== ''
    const runtime = remote ? this.hosts.pair(host) : undefined
    if (runtime !== undefined) await runtime.ready
    const fs = runtime?.fs ?? this.ctx.fs
    if (!isAbsolute(path)) throw new Error(`browse needs an absolute path, got ${JSON.stringify(path)}`)
    const resolved = await fs.resolve(path)
    const info = await fs.stat(resolved)
    const machine = remote ? host : 'this machine'
    if (info?.type !== 'directory') throw new Error(`${JSON.stringify(path)} is not a directory on ${machine}`)
    const canonical = fs.processPath(resolved)
    const entries = await fs.listDir(resolved)
    const parent = posix.dirname(canonical)
    return {
      path: canonical,
      ...(parent === canonical ? {} : { parent }),
      entries: entries
        .filter(entry => entry.type === 'directory')
        .map(entry => ({ name: entry.name, path: fs.processPath(entry.target), hidden: entry.name.startsWith('.') }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    }
  }

  /** Every adopted remote workspace. */
  records(): readonly RemoteWorkspaceRecord[] {
    return this.state.snapshot()
  }

  /** The host alias owning one workspace id, when it is a remote workspace. */
  hostOfWorkspace(workspaceId: string): string | undefined {
    return this.state.byWorkspace(workspaceId)?.host
  }
}

export default SshWorkspaceMount
