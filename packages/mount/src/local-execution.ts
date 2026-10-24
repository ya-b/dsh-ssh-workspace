/**
 * Local-side working directory and sandbox policy for ordinary tools running
 * in an adopted remote workspace. A remote session's header cwd is a path on
 * the host, so the stock `workingDirectory` service would hand it to the local
 * `read`/`bash`/`grep` tools as well. These patches apply only inside a
 * `local` tool scope and only for a session attributed to a remote workspace;
 * the terminal tools and `remote_*` aliases keep the host path.
 * @module @dsh-ssh-workspace/mount/local-execution
 */

import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { isLocalToolScope } from './tool-scope.ts'
import type { RemoteWorkspaceState } from './state.ts'

/** Structural session slice needed to attribute a call. */
interface SessionLike {
  readonly header?: { readonly cwd?: string } | undefined
}

/** Structural agent slice needed by `workingDirectory`. */
interface AgentLike {
  readonly session: SessionLike
}

/** Local filesystem slice used to validate a local directory. */
type LocalFileSystemLike = Pick<FileSystem, 'resolve' | 'stat' | 'processPath'>

/** `workingDirectory` service slice patched below. */
interface WorkingDirectoryHost {
  get(session: SessionLike): string
  ensure(agent: AgentLike, signal?: AbortSignal): Promise<string>
  set(agent: AgentLike, path: string, signal?: AbortSignal): Promise<string>
}

/** `sandboxPolicy.resolve` result slice patched below. */
interface SandboxPolicyLike {
  readonly workspaceRoot: string
  readonly [key: string]: unknown
}

/** `sandboxPolicy` service slice patched below. */
interface SandboxPolicyHost {
  resolve(request?: { session?: SessionLike, readonly [key: string]: unknown }): SandboxPolicyLike
}

/** Per-session local directories; the default is used before a local `cd`. */
export interface LocalCwdStore {
  readonly defaultCwd: string
  of(session: object): string
  set(session: object, cwd: string): void
}

const patchedWorkingDirectories = new WeakSet<object>()
const patchedSandboxPolicies = new WeakSet<object>()

/** Create the mutable per-session local directory map shared by the patches. */
export function createLocalCwdStore(defaultCwd: string): LocalCwdStore {
  const directories = new WeakMap<object, string>()
  return {
    defaultCwd,
    of: session => directories.get(session) ?? defaultCwd,
    set: (session, cwd) => { directories.set(session, cwd) },
  }
}

function sessionCwd(session: SessionLike): string | undefined {
  const cwd = session.header?.cwd
  return cwd === undefined || cwd === '' ? undefined : cwd
}

function isRemoteSession(state: Pick<RemoteWorkspaceState, 'covering'>, session: SessionLike): boolean {
  const cwd = sessionCwd(session)
  return cwd !== undefined && state.covering(cwd) !== undefined
}

/**
 * Resolve one local directory and return its canonical spelling. A relative
 * path resolves from `cwd`, matching `workingDirectory`'s contract.
 */
async function localDirectory(
  fs: LocalFileSystemLike,
  path: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const target = await fs.resolve(path, { cwd, signal })
  const info = await fs.stat(target, signal)
  signal?.throwIfAborted()
  if (info?.type !== 'directory') {
    throw new Error(`working-directory: directory does not exist: ${JSON.stringify(path)}`)
  }
  return fs.processPath(target)
}

/**
 * Patch `workingDirectory` so a local tool in a remote workspace gets a real
 * local current directory. The remote session projection is deliberately left
 * untouched: the UI, the terminal tools, and `remote_*` still read the host cwd.
 * @param service - live `workingDirectory` service.
 * @param state - remote workspace attribution sidecar.
 * @param store - per-session local directory map.
 * @param getFileSystem - the live `ctx.fs` (the local scope reaches the local provider).
 */
export function patchLocalWorkingDirectory(
  service: WorkingDirectoryHost,
  state: Pick<RemoteWorkspaceState, 'covering'>,
  store: LocalCwdStore,
  getFileSystem: () => LocalFileSystemLike,
): void {
  if (patchedWorkingDirectories.has(service)) return
  patchedWorkingDirectories.add(service)
  const originalGet = service.get.bind(service)
  const originalEnsure = service.ensure.bind(service)
  const originalSet = service.set.bind(service)

  service.get = session => {
    if (isLocalToolScope() && isRemoteSession(state, session)) return store.of(session)
    return originalGet(session)
  }
  service.ensure = async (agent, signal) => {
    if (!isLocalToolScope() || !isRemoteSession(state, agent.session)) return await originalEnsure(agent, signal)
    const fs = getFileSystem()
    const current = store.of(agent.session)
    const canonical = await localDirectory(fs, current, current, signal)
    store.set(agent.session, canonical)
    return canonical
  }
  service.set = async (agent, path, signal) => {
    if (!isLocalToolScope() || !isRemoteSession(state, agent.session)) return await originalSet(agent, path, signal)
    if (path.length === 0) throw new Error('working-directory: cd must not be empty')
    const fs = getFileSystem()
    const canonical = await localDirectory(fs, path, store.of(agent.session), signal)
    store.set(agent.session, canonical)
    return canonical
  }
}

/**
 * Patch `sandboxPolicy.resolve` so a local tool's workspace-write boundary is
 * the local directory, not the remote workspace path carried by the session.
 * @param service - live `sandboxPolicy` service.
 * @param state - remote workspace attribution sidecar.
 * @param store - per-session local directory map.
 */
export function patchLocalSandboxPolicy(
  service: SandboxPolicyHost,
  state: Pick<RemoteWorkspaceState, 'covering'>,
  store: LocalCwdStore,
): void {
  if (patchedSandboxPolicies.has(service)) return
  patchedSandboxPolicies.add(service)
  const original = service.resolve.bind(service)
  service.resolve = request => {
    const policy = original(request)
    const session = request?.session
    if (!isLocalToolScope() || session === undefined || !isRemoteSession(state, session)) return policy
    return { ...policy, workspaceRoot: store.of(session) }
  }
}
