/**
 * Execution-world realm backed by the remote workspace daemon instead of the
 * official SSH helper. This is a drop-in replacement for the
 * `execution-worlds` row: it subclasses {@link WorkspaceRuntimeRegistry} and
 * overrides only the provider mount, so realm isolation, workspace routing,
 * the remote verifier, and the per-(host, path) realm cache all stay the
 * upstream implementation.
 *
 * The base class still builds one `SshConfig` per realm as a bookkeeping step;
 * that config is satisfied with inert values and never reaches a helper
 * process. Everything the realm needs comes from this entry's own deployment
 * fields plus the workspace's host alias and path.
 * @module @dsh-ssh-workspace/realm
 */

import { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { WorkspaceRuntimeRegistry, type SshDeploymentConfig } from '@deepseek-ai/dsh-host-execution-worlds'
import type { Config as SshConfig } from '@deepseek-ai/dsh-ssh'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'
import { SshSandboxProvider } from '@deepseek-ai/dsh-sandbox-ssh'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { DaemonSshConnection, createTransport } from '@dsh-ssh-workspace/providers'
import type { RemoteWorkspaceConfig } from '@dsh-ssh-workspace/transport'
import { installDaemonArchive } from '@dsh-ssh-workspace/install'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/**
 * Host-plane services a realm's providers read but never shadow. Cordis
 * resolves a service through the *providing fiber's* store walk, so a service
 * registered on the host plane is unreachable from an isolated realm's own
 * fibers: the realm re-exposes the same value as a scope property instead.
 * Isolated names are excluded by construction; those are what the realm
 * replaces.
 */
const BRIDGED_SERVICES = ['sandboxPolicy', 'sessionProjections'] as const

/** Service names the realm shadows from the host plane. */
const REALM_NAMES: readonly string[] = ['ssh', 'fs', 'subprocess', 'sandbox', 'shell']

/** Inert values satisfying the base class's helper-oriented config contract. */
const INERT_HELPER = 'dsh-workspace-daemon'
const INERT_HASH = 'dsh-workspace-daemon'

/** Deployment fields this realm adds on top of the base class's SSH contract. */
export interface RemoteRealmConfig extends SshDeploymentConfig {
  /** Remote daemon state directory; `~/` is expanded by the remote shell. */
  daemonDir?: string
  /** Absolute remote Node executable used to run and bridge to the daemon. */
  node?: string
  /** Reconnect backoff base in milliseconds. */
  reconnectBaseMs?: number
  /** Reconnect backoff ceiling in milliseconds. */
  reconnectMaxMs?: number
  /** Local SSH control directory; a temp directory when absent. */
  controlDir?: string
  /** Install the shipped daemon archive on first use of a (host, directory). */
  install?: boolean
  /** Override the shipped daemon archive path, for development. */
  daemonArchive?: string
}

type ResolvedConfig = {
  daemonDir: string
  node: string
  requestTimeoutMs: number
  reconnectBaseMs: number
  reconnectMaxMs: number
  controlDir?: string
  install: boolean
  daemonArchive?: string
  maxFrameBytes?: number
  maxPending?: number
} & SshDeploymentConfig

/** Installs in flight or finished, keyed by host, directory, and archive digest. */
const installs = new Map<string, Promise<void>>()

/** Digest of the archive shipped beside this package, computed once. */
let archiveDigest: Promise<{ path: string; sha256: string } | undefined> | undefined

/**
 * Locate and hash the shipped daemon archive. A development checkout may build
 * it on demand; a published package always carries it.
 * @returns the archive path and digest, or undefined when none is shipped.
 */
function shippedArchive(): Promise<{ path: string; sha256: string } | undefined> {
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

/**
 * Deployment settings of the daemon-backed execution worlds. The helper
 * oriented fields are accepted so an existing profile row keeps loading, and
 * are otherwise unused.
 */
export class RemoteWorkspaceRegistry extends WorkspaceRuntimeRegistry {
  static Config = schema.object({
    daemonDir: schema.string().default('~/.dsh-workspace'),
    node: schema.string().default('node'),
    requestTimeoutMs: schema.number().min(1).max(2_147_483_647).default(30_000),
    reconnectBaseMs: schema.number().min(10).max(60_000).default(250),
    reconnectMaxMs: schema.number().min(100).max(600_000).default(15_000),
    controlDir: schema.string(),
    install: schema.boolean().default(true),
    daemonArchive: schema.string(),
    launchKind: schema.union(['node-script', 'executable'] as const).default('executable'),
    helper: schema.string().default(INERT_HELPER),
    helperHash: schema.string().default(INERT_HASH),
    bootstrapPath: schema.string(),
    bootstrapHash: schema.string(),
    maxFrameBytes: schema.number(),
    maxPending: schema.number(),
    leaseMs: schema.number(),
  })

  private readonly realm: ResolvedConfig

  constructor(ctx: Context, config: RemoteRealmConfig = {}) {
    const resolved = RemoteWorkspaceRegistry.Config({
      helper: INERT_HELPER, helperHash: INERT_HASH, launchKind: 'executable', node: 'node', ...config,
    }) as unknown as ResolvedConfig
    super(ctx, resolved)
    this.realm = resolved
  }

  /**
   * Mount the daemon-backed connection and the official provider family into
   * the realm. The providers are upstream code: they see the same
   * `request` / `connectStream` / `dispose` surface they always have.
   * @param realmCtx - isolated child context of this realm.
   * @param config - the realm's target coordinates.
   */
  protected async mountRealmProviders(realmCtx: Context, config: SshConfig): Promise<void> {
    await this.prepareDaemon(config.host)
    const scope = this.bridgeHostServices(realmCtx)
    const transport = createTransport(this.transportConfig(config.host, config.workspace))
    await scope.plugin(DaemonSshConnection, { transport })
    await scope.plugin(SshFileSystem)
    await scope.plugin(SshSubprocessRuntime)
    await scope.plugin(SshSandboxProvider)
    await scope.plugin(SandboxBashExecutor, {})
  }

  /**
   * Re-expose the host plane's non-shadowed services the realm providers read,
   * as scope properties of the realm. Registration still happens on the realm
   * fibers, so disposal and isolation are unchanged.
   * @param realmCtx - isolated child context of this realm.
   * @returns the realm context carrying those properties.
   */
  private bridgeHostServices(realmCtx: Context): Context {
    const carried: Record<string, unknown> = {}
    for (const name of BRIDGED_SERVICES) {
      if (REALM_NAMES.includes(name)) continue
      const value = this.ctx.get(name as 'sandbox', false)
      if (value !== undefined) carried[name] = value
    }
    return Object.keys(carried).length === 0 ? realmCtx : realmCtx.extend(carried)
  }

  /** Ship the daemon to one host once per archive digest, then reuse it. */
  private async prepareDaemon(host: string): Promise<void> {
    const config = this.transportConfig(host, '')
        const install = this.realm.install
    const override = this.realm.daemonArchive
    const archive = override === undefined ? undefined : { path: override, sha256: 'override' }
    if (!install && archive === undefined) return
    const shipped = archive ?? await shippedArchive()
    if (shipped === undefined) {
      throw new Error(
        `remote workspace daemon archive is missing; build it with 'pnpm run archive' in the execution-worlds plugin `
        + `or set daemonArchive in the execution-worlds settings`,
      )
    }
    const digest = shipped.sha256 === '' ? '' : shipped.sha256
    const key = `${host}\u0000${config.daemonDir}\u0000${digest}`
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

  /** One transport configuration for a host, and optionally a workspace. */
  private transportConfig(host: string, workspace: string): RemoteWorkspaceConfig {
    const realm = this.realm
    return {
      host,
      workspace,
      daemonDir: realm.daemonDir,
      node: realm.node,
      requestTimeoutMs: realm.requestTimeoutMs,
      reconnectBaseMs: realm.reconnectBaseMs,
      reconnectMaxMs: realm.reconnectMaxMs,
      ...(realm.controlDir === undefined ? {} : { controlDir: realm.controlDir }),
      ...(realm.maxFrameBytes === undefined ? {} : { maxFrameBytes: realm.maxFrameBytes }),
      ...(realm.maxPending === undefined ? {} : { maxPending: realm.maxPending }),
    }
  }
}

export default RemoteWorkspaceRegistry
