/**
 * Root-plane routers. rc.2 resolves `ctx.fs` / `ctx.subprocess` / `ctx.sandbox`
 * once per process, while this plugin serves many machines at once: each
 * router keeps the official local provider as the fallback and dispatches an
 * operation to the daemon-backed provider of the host that owns the path, cwd,
 * or sandbox root the call carries. Routing is deliberate and narrow:
 *
 * - filesystem: a resolved target or path is remote only when it lies under a
 *   known remote workspace root; a relative path resolves against its cwd, so
 *   a remote session's tool calls land on its own host.
 * - subprocess: the decisive field is the working directory. `spawn` is
 *   synchronous, so a host that has never been paired fails loudly instead of
 *   guessing.
 * - sandbox: the per-call policy's `workspaceRoot` is the session's immutable
 *   workspace path, which is exactly the host attribution.
 * - terminal: the terminal controller reads `agent.ctx.get('subprocess')`, a
 *   lookup no root router can answer; its `execution` method is patched to
 *   swap in the session host's provider, so PTY allocation, shell discovery,
 *   and spawn all run on the owning machine.
 *
 * @module @dsh-ssh-workspace/mount/patch
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget, FileSystem, FsEditRequest } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessRuntime, SubprocessSpawnSpec, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { RemoteHosts, HostRuntime } from './hosts.ts'
import type { RemoteWorkspaceRecord } from './state.ts'
import { isLocalToolScope } from './tool-scope.ts'
import { basename, isAbsolute } from 'node:path'

/** The attribution slice every router reads. */
export interface RootIndex {
  covering(path: string): RemoteWorkspaceRecord | undefined
  /** Read-only adjacent probe fallback; see {@link RemoteWorkspaceState.adjacent}. */
  adjacent(path: string): RemoteWorkspaceRecord | undefined
}

/** Instances already carrying routers, so a reload never double-wraps them. */
const routed = new WeakSet<object>()

/**
 * Attribute one path-shaped call: an absolute path first, then the cwd the
 * caller supplied. Only known remote roots participate, so host-plane reads of
 * local files stay local even from a remote session.
 * @param state - remote workspace attribution records.
 * @param path - path as the caller spelled it.
 * @param cwd - optional working directory the call runs under.
 */
function attributePath(state: RootIndex, path: string, cwd?: string): RemoteWorkspaceRecord | undefined {
  if (isAbsolute(path)) return state.covering(path)
  return cwd === undefined ? undefined : state.covering(cwd)
}

/**
 * Wrap the `ctx.fs` singleton so remote paths reach the owning host's
 * daemon-backed provider. Pure path functions (`processPath`, `fileUrl`,
 * `contains`, `sandboxMode`, `processPathFromHostPath`) stay untouched: they
 * are lexical or provider-local and produce identical answers for both worlds.
 * Read-only calls whose path the local plane cannot even traverse
 * (`EACCES`/`EPERM`) retry on the host whose workspace root sits beside the
 * path, because upstream discovery probes markers above a remote session cwd.
 * @param ctx - host plugin context (for the fallback warning).
 * @param fs - the live `ctx.fs` instance.
 * @param hosts - host runtime pool.
 * @param state - remote workspace attribution records.
 */
export function patchFileSystem(ctx: Context, fs: FileSystem, hosts: RemoteHosts, state: RootIndex): void {
  if (routed.has(fs)) return
  routed.add(fs)
  const local = {
    resolve: fs.resolve.bind(fs),
    stat: fs.stat.bind(fs),
    lstat: fs.lstat.bind(fs),
    readText: fs.readText.bind(fs),
    streamText: fs.streamText.bind(fs),
    readBytes: fs.readBytes.bind(fs),
    readByteRange: fs.readByteRange.bind(fs),
    listDir: fs.listDir.bind(fs),
    writeText: fs.writeText.bind(fs),
    editText: fs.editText.bind(fs),
    watch: fs.watch.bind(fs),
    processPath: fs.processPath.bind(fs),
  }
  const remote = (record: RemoteWorkspaceRecord | undefined) => {
    if (record === undefined) return undefined
    const runtime = hosts.peek(record.host)
    if (runtime === undefined) {
      ctx.logger.warn(`ssh-workspace: host '${record.host}' is not connected yet; remote path '${record.path}' fell back to the local filesystem`)
    }
    return runtime
  }
  /** Whether the local plane refused the call outright (unreadable ancestor). */
  const permissionDenied = (error: unknown): boolean => {
    const cause = (error as { cause?: unknown } | null)?.cause
    return [error, cause].some(value =>
      value !== null && typeof value === 'object' && ((value as { code?: unknown }).code === 'EACCES' || (value as { code?: unknown }).code === 'EPERM'))
  }
  /**
   * Run one read-only call locally, and when the local plane cannot even
   * traverse the path, retry on the host whose workspace root sits beside it.
   * Upstream project discovery walks *above* a session cwd probing markers
   * (`.git`, instruction files), which spells paths no `covering` match
   * explains while the session plainly belongs to the remote machine.
   */
  const probe = async <T>(path: string, run: () => Promise<T>, fallback: (runtime: HostRuntime) => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      if (!permissionDenied(error)) throw error
      const record = state.adjacent(path)
      const runtime = record === undefined ? undefined : hosts.peek(record.host)
      if (record === undefined || runtime === undefined) throw error
      ctx.logger.debug(`ssh-workspace: local '${path}' is untraversable; probing ${record.host} instead`)
      return await fallback(runtime)
    }
  }

  fs.resolve = async (path, opts) => {
    if (isLocalToolScope()) return await local.resolve(path, opts)
    const runtime = remote(attributePath(state, path, opts?.cwd))
    if (runtime !== undefined) return await runtime.fs.resolve(path, opts)
    return await probe(path, () => local.resolve(path, opts), fallback => fallback.fs.resolve(path, opts))
  }
  fs.stat = async (target, signal) => {
    if (isLocalToolScope()) return await local.stat(target, signal)
    const runtime = remote(owner(target))
    if (runtime !== undefined) return await runtime.fs.stat(target, signal)
    return await probe(local.processPath(target), () => local.stat(target, signal), fallback => fallback.fs.stat(target, signal))
  }
  fs.lstat = async (path, opts, signal) => {
    if (isLocalToolScope()) return await local.lstat(path, opts, signal)
    const runtime = remote(attributePath(state, path, opts?.cwd))
    if (runtime !== undefined) return await runtime.fs.lstat(path, opts, signal)
    return await probe(path, () => local.lstat(path, opts, signal), fallback => fallback.fs.lstat(path, opts, signal))
  }
  fs.readText = async (target, signal) => {
    if (isLocalToolScope()) return await local.readText(target, signal)
    const runtime = remote(owner(target))
    if (runtime !== undefined) return await runtime.fs.readText(target, signal)
    return await probe(local.processPath(target), () => local.readText(target, signal), fallback => fallback.fs.readText(target, signal))
  }
  fs.streamText = async (target, signal) => {
    if (isLocalToolScope()) return await local.streamText(target, signal)
    const runtime = remote(owner(target))
    if (runtime !== undefined) return await runtime.fs.streamText(target, signal)
    return await probe(local.processPath(target), () => local.streamText(target, signal), fallback => fallback.fs.streamText(target, signal))
  }
  fs.readBytes = async (target, signal, maxBytes) => {
    if (isLocalToolScope()) return await local.readBytes(target, signal, maxBytes)
    const runtime = remote(owner(target))
    if (runtime !== undefined) return await runtime.fs.readBytes(target, signal, maxBytes)
    return await probe(local.processPath(target), () => local.readBytes(target, signal, maxBytes), fallback => fallback.fs.readBytes(target, signal, maxBytes))
  }
  fs.readByteRange = async (target, range, signal) => {
    if (isLocalToolScope()) return await local.readByteRange(target, range, signal)
    const runtime = remote(owner(target))
    if (runtime !== undefined) return await runtime.fs.readByteRange(target, range, signal)
    return await probe(local.processPath(target), () => local.readByteRange(target, range, signal), fallback => fallback.fs.readByteRange(target, range, signal))
  }
  fs.listDir = async (target, signal) => {
    if (isLocalToolScope()) return await local.listDir(target, signal)
    const runtime = remote(owner(target))
    if (runtime !== undefined) return await runtime.fs.listDir(target, signal)
    return await probe(local.processPath(target), () => local.listDir(target, signal), fallback => fallback.fs.listDir(target, signal))
  }
  fs.writeText = async (target, content, expected, signal, policy) => {
    if (isLocalToolScope()) return await local.writeText(target, content, expected, signal, policy)
    const runtime = remote(owner(target, policy))
    return runtime === undefined
      ? await local.writeText(target, content, expected, signal, policy)
      : await runtime.fs.writeText(target, content, expected, signal, policy)
  }
  fs.editText = async (target, edit: FsEditRequest, expected, signal, policy) => {
    if (isLocalToolScope()) return await local.editText(target, edit, expected, signal, policy)
    const runtime = remote(owner(target, policy))
    return runtime === undefined
      ? await local.editText(target, edit, expected, signal, policy)
      : await runtime.fs.editText(target, edit, expected, signal, policy)
  }
  fs.watch = async (target, changed, signal) => {
    if (isLocalToolScope()) return await local.watch(target, changed, signal)
    const runtime = remote(owner(target))
    return runtime === undefined ? await local.watch(target, changed, signal) : await runtime.fs.watch(target, changed, signal)
  }

  /** The host that owns a mutation: its explicit policy root wins over the target path. */
  function owner(target: FsTarget, policy?: SandboxExecutionPolicy): RemoteWorkspaceRecord | undefined {
    if (policy !== undefined) {
      const byRoot = state.covering(policy.workspaceRoot)
      if (byRoot !== undefined) return byRoot
    }
    return state.covering(local.processPath(target))
  }
}

/** The packaged ripgrep binary official grep/glob spawn, in any install layout. */
const PACKAGED_RIPGREP = /[\\/]@vscode[\\/]ripgrep(?:-[^\\/]+)?[\\/]bin[\\/]rg(?:\.exe)?$/iu

function packagedRipgrep(path: string): boolean {
  const name = basename(path).toLowerCase()
  return (name === 'rg' || name === 'rg.exe') && PACKAGED_RIPGREP.test(path)
}

/**
 * Official grep/glob spawn the *local* packaged ripgrep path. On a remote
 * workspace that binary does not exist, so substitute the daemon's bundled
 * binary; every other argv (including a user's own `rg`) passes through.
 */
function remoteArgv(argv: readonly string[], runtime: HostRuntime): readonly string[] {
  const executable = argv[0]
  if (executable === undefined || !packagedRipgrep(executable)) return argv
  const rg = runtime.transport.hello?.rg
  if (rg === undefined || rg === null) {
    throw new Error(`remote host '${runtime.host}' has no bundled ripgrep; use remote_bash with grep/find or reinstall the daemon`)
  }
  return [rg, ...argv.slice(1)]
}

/**
 * Wrap `ctx.subprocess` so spawns whose working directory is a remote
 * workspace root run on that host. A packaged ripgrep argv[0] is rewritten to
 * the daemon's bundled binary before the remote spawn. `resolveExecutable` and
 * `terminalEnvironment` stay local: they carry no directory, and the one
 * session-aware consumer (the terminal controller) is patched separately.
 * @param ctx - host plugin context (unused today; kept for symmetry and logging).
 * @param subprocess - the live `ctx.subprocess` instance.
 * @param hosts - host runtime pool.
 * @param state - remote workspace attribution records.
 */
export function patchSubprocess(ctx: Context, subprocess: SubprocessRuntime, hosts: RemoteHosts, state: RootIndex): void {
  void ctx
  if (routed.has(subprocess)) return
  routed.add(subprocess)
  const localSpawn = subprocess.spawn.bind(subprocess)
  const localSpawnTerminal = subprocess.spawnTerminal.bind(subprocess)

  subprocess.spawn = (spec: SubprocessSpawnSpec) => {
    if (isLocalToolScope()) return localSpawn(spec)
    const record = state.covering(spec.cwd)
    if (record === undefined) return localSpawn(spec)
    const runtime = hosts.peek(record.host)
    if (runtime === undefined) throw new Error(`remote host '${record.host}' is not connected in this process yet; retry once the workspace reconnects`)
    const argv = remoteArgv(spec.argv, runtime)
    return runtime.subprocess.spawn(argv === spec.argv ? spec : { ...spec, argv })
  }
  subprocess.spawnTerminal = async (spec: SubprocessTerminalSpawnSpec) => {
    if (isLocalToolScope()) return await localSpawnTerminal(spec)
    const record = state.covering(spec.cwd)
    if (record === undefined) return await localSpawnTerminal(spec)
    const runtime = hosts.pair(record.host)
    await runtime.ready
    return await runtime.subprocess.spawnTerminal(spec)
  }
}

/**
 * Wrap `ctx.sandbox` so confinement resolves on the machine that owns the
 * policy's workspace root — the session's immutable workspace path.
 * @param sandbox - the live `ctx.sandbox` instance.
 * @param hosts - host runtime pool.
 * @param state - remote workspace attribution records.
 */
export function patchSandbox(sandbox: Pick<SandboxPolicyHost, 'confine'>, hosts: RemoteHosts, state: RootIndex): void {
  if (routed.has(sandbox)) return
  routed.add(sandbox)
  const local = sandbox.confine.bind(sandbox)
  sandbox.confine = async (argv, policy, signal) => {
    if (isLocalToolScope()) return await local(argv, policy, signal)
    const record = state.covering(policy.workspaceRoot)
    if (record === undefined) return await local(argv, policy, signal)
    const runtime = hosts.pair(record.host)
    await runtime.ready
    return await runtime.sandbox.confine(argv, policy, signal)
  }
}

/** The confinement surface the sandbox router wraps. */
interface SandboxPolicyHost {
  confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<unknown>
}

/** The terminal session surface this patch reads. */
interface TerminalSessionLike {
  header?: { cwd?: string } | undefined
}
/** The agent surface this patch reads. */
interface AgentLike {
  session?: TerminalSessionLike | undefined
}
/** The controller's resolved execution trio, kept loose on purpose. */
interface ExecutionEnvironment {
  subprocess?: unknown
  sandboxPolicy?: unknown
  workingDirectory?: unknown
}

/**
 * Patch the terminal controller's `execution(agent)` so a session on a remote
 * workspace gets its host's subprocess provider. Everything else the
 * controller does (shell discovery, PTY spawn, activity) flows through that
 * provider unchanged.
 * @param controller - the live `ctx.terminalController` instance.
 * @param hosts - host runtime pool.
 * @param state - remote workspace attribution records.
 */
export function patchTerminalController(
  controller: { execution(agent: AgentLike): ExecutionEnvironment },
  hosts: RemoteHosts,
  state: RootIndex,
): void {
  if (routed.has(controller)) return
  routed.add(controller)
  const original = controller.execution.bind(controller)
  controller.execution = (agent: AgentLike): ExecutionEnvironment => {
    const base = original(agent)
    const cwd = agent.session?.header?.cwd
    const record = cwd === undefined ? undefined : state.covering(cwd)
    if (record === undefined) return base
    const runtime = hosts.peek(record.host)
    if (runtime === undefined) return base
    return { ...base, subprocess: runtime.subprocess }
  }
}

/** The session-controller agent roster (`ctx.sessionController.agents`) slice the session router wraps. */
interface SessionAgentsLike {
  ctx: { agents: { create(input: Record<string, unknown>): Promise<{ agent: unknown }> } }
  createAgent(sessionId: string, cwd: string, composition: Record<string, unknown>): Promise<unknown>
  agentOptions(): unknown
}

/** The `ctx.sessionController` slice that owns the agent roster. */
interface SessionControllerLike {
  agents?: SessionAgentsLike
}

/**
 * Patch the session controller's agent roster so a session on a remote
 * workspace neither `mkdir`s the remote path on the harness machine nor
 * demands a local directory. Creation on rc.2 funnels through
 * `SessionCommandController.create` → `agents.createSession` →
 * `agents.createMinted` → `agents.createAgent`, so the roster instance is the
 * single choke point. The remote directory is verified through the owning
 * host's filesystem, then the session is minted exactly as upstream does
 * after its mkdir. Creation pairs the host on demand and awaits its `ready`
 * promise: a host whose startup handshake failed has no runtime left in the
 * pool, and only an awaited pair reconnects it, so a host that came back
 * after being down recovers on the next creation instead of demanding a
 * process restart.
 * @param controller - the live `ctx.sessionController` instance.
 * @param hosts - host runtime pool.
 * @param state - remote workspace attribution records.
 */
export function patchSessionController(
  controller: SessionControllerLike,
  hosts: RemoteHosts,
  state: RootIndex,
): void {
  const agents = controller.agents
  if (agents === undefined || typeof agents.createAgent !== 'function') return
  if (routed.has(agents)) return
  routed.add(agents)
  const original = agents.createAgent.bind(agents)
  agents.createAgent = async (sessionId, cwd, composition) => {
    const record = state.covering(cwd)
    if (record === undefined) return await original(sessionId, cwd, composition)
    const runtime = hosts.pair(record.host)
    await runtime.ready
    const target = await runtime.fs.resolve(cwd)
    const info = await runtime.fs.stat(target)
    if (info?.type !== 'directory') throw new Error(`${JSON.stringify(cwd)} is not a directory on ${record.host}`)
    const preset = composition.agentPreset
    return (await agents.ctx.agents.create({
      sessionId,
      agentOptions: agents.agentOptions(),
      meta: { cwd, ...preset === undefined ? {} : { agentPreset: preset } },
      setup: composition.setup,
    })).agent
  }
}
