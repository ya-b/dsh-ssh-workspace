/**
 * Workspace adoption on the official registry. 0.2.1's `WorkspaceRegistry.create`
 * canonicalizes through the *local* realpath and `attachSession` re-checks the
 * session cwd the same way, so a remote directory can never become a record
 * through the public surface. This module keeps the registry authoritative and
 * patches exactly the three seams that assume a local filesystem:
 *
 * - `createCanonical` is reused verbatim to mint the durable record (order,
 *   pending-mutation marker, entity construction all stay upstream); only the
 *   local realpath/stat prelude of `create` is replaced by a remote stat.
 * - `indexHeader` learns the remote canonical spelling so resumed sessions on
 *   a remote workspace stay indexed as members.
 * - `WorkspaceEntity.attachSession` accepts the remote cwd when the record is
 *   attributed to a host, instead of realpathing it on the harness machine.
 *
 * The workspace record itself carries no host field (its schema is strict), so
 * attribution lives in the sidecar and is written before the record is
 * published to callers.
 *
 * @module @dsh-ssh-workspace/mount/registry
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RemoteHosts } from './hosts.ts'
import { canonicalSpelling, type RemoteWorkspaceRecord, type RemoteWorkspaceState } from './state.ts'

/** One workspace entity as this module touches it. */
export interface WorkspaceEntityLike {
  id: string
  path: string
  title: string
  sessionIds: string[]
  record: { sessionIds: string[], path: string }
  host: {
    readSessionHeader(id: string): Promise<{ cwd?: string }>
    rememberSessionPath(id: string, path: string): void
  }
  mutate(fn: (record: Record<string, unknown>) => Record<string, unknown>): Promise<void>
}

/** The registry surface this module reads and patches, kept structural. */
export interface RegistryLike {
  get(id: string): WorkspaceEntityLike | undefined
  list(): WorkspaceEntityLike[]
  createCanonical(canonical: string, title?: string, firstUse?: boolean): Promise<WorkspaceEntityLike>
  enqueueOperation<T>(work: () => Promise<T>): Promise<T>
  delete(id: string): Promise<boolean>
  indexHeader(header: { id: string, cwd?: string }): Promise<void>
  resolveByPath(path: string): Promise<WorkspaceEntityLike | undefined>
  sessionPaths: Map<string, string>
  missingSessionPaths: Set<string>
  invalidSessionPaths: Map<string, string>
}

/** Prototypes already carrying the remote-aware attach, so reloads never double-wrap. */
const patched = new WeakSet<object>()

/**
 * Patch the registry instance: resolve-by-path, header indexing, deletion
 * bookkeeping, and the entity prototype. Idempotent per process.
 * @param ctx - host plugin context.
 * @param registry - the live `ctx.workspaceRegistry` instance.
 * @param state - remote workspace attribution records.
 */
export function patchRegistry(ctx: Context, registry: RegistryLike, state: RemoteWorkspaceState): void {
  const originalResolve = registry.resolveByPath.bind(registry)
  registry.resolveByPath = async (path: string) => {
    const found = await originalResolve(path).catch(() => undefined)
    if (found !== undefined) return found
    const record = state.exact(path)
    return record === undefined ? undefined : registry.get(record.workspaceId)
  }

  const originalIndex = registry.indexHeader.bind(registry)
  registry.indexHeader = async (header: { id: string, cwd?: string }) => {
    await originalIndex(header)
    if (typeof header?.cwd !== 'string') return
    const record = state.exact(header.cwd)
    if (record === undefined) return
    registry.sessionPaths.set(header.id, record.path)
    registry.missingSessionPaths.delete(header.id)
    registry.invalidSessionPaths.delete(header.id)
    ctx.logger.debug(`ssh-workspace: session '${header.id}' indexed against remote workspace path '${record.path}' on '${record.host}'`)
  }

  const originalDelete = registry.delete.bind(registry)
  registry.delete = async (id: string) => {
    const deleted = await originalDelete(id)
    if (deleted) await state.remove(id)
    return deleted
  }

  const sample = registry.list()[0]
  if (sample !== undefined) patchEntityPrototype(Object.getPrototypeOf(sample) as object, state)
}

/**
 * Patch the entity prototype so attaching a session to a remote workspace
 * validates the stored cwd against the remote canonical path instead of the
 * harness machine's realpath.
 * @param prototype - `WorkspaceEntity.prototype`.
 * @param state - remote workspace attribution records.
 */
export function patchEntityPrototype(prototype: object, state: RemoteWorkspaceState): void {
  if (patched.has(prototype)) return
  patched.add(prototype)
  const target = prototype as {
    attachSession(this: WorkspaceEntityLike, sessionId: string): Promise<void>
  }
  const original = target.attachSession
  target.attachSession = async function (this: WorkspaceEntityLike, sessionId: string): Promise<void> {
    const attribution = state.byWorkspace(String(this.id))
    if (attribution === undefined || attribution.path !== this.path) return await original.call(this, sessionId)
    if (!this.record.sessionIds.includes(sessionId)) {
      const header = await this.host.readSessionHeader(sessionId)
      if (header.cwd === undefined) {
        throw new Error(`cannot attach session '${sessionId}' to workspace '${this.record.path}': its stored header carries no cwd to validate against`)
      }
      if (canonicalSpelling(header.cwd) !== this.record.path) {
        throw new Error(`cannot attach session '${sessionId}' to workspace '${this.record.path}': its cwd '${header.cwd}' does not match the remote workspace path`)
      }
      this.host.rememberSessionPath(sessionId, this.record.path)
    }
    await this.mutate(record => (record.sessionIds as string[]).includes(sessionId) ? record : {
      ...record,
      sessionIds: [sessionId, ...(record.sessionIds as string[])],
    })
  }
}

/**
 * Adopt one remote directory as a workspace: verify it on its host, reuse the
 * durable record when one exists, mint it through the registry's own
 * createCanonical when not, and record the host attribution.
 * @param registry - the live `ctx.workspaceRegistry` instance.
 * @param hosts - host runtime pool.
 * @param state - remote workspace attribution records.
 * @param input - target host, directory, and optional initial title.
 */
export async function adoptRemoteWorkspace(
  registry: RegistryLike,
  hosts: RemoteHosts,
  state: RemoteWorkspaceState,
  input: { host: string, path: string, title?: string },
): Promise<WorkspaceEntityLike> {
  const runtime = hosts.pair(input.host)
  await runtime.ready
  const target = await runtime.fs.resolve(input.path)
  const info = await runtime.fs.stat(target)
  if (info?.type !== 'directory') throw new Error(`${JSON.stringify(input.path)} is not a directory on ${input.host}`)
  const canonical = canonicalSpelling(runtime.fs.processPath(target))
  await runtime.allow(canonical)

  const attributed = (await state.list()).find(record => record.host === input.host && record.path === canonical)
  const existing = attributed === undefined ? undefined : registry.get(attributed.workspaceId)
  if (existing !== undefined) {
    patchEntityPrototype(Object.getPrototypeOf(existing) as object, state)
    await remember(state, existing, input.host, canonical)
    return existing
  }

  const colliding = registry.list().find(entity => entity.path === canonical)
  if (colliding !== undefined) {
    const owner = state.byWorkspace(String(colliding.id))
    if (owner !== undefined && owner.host !== input.host) {
      throw new Error(`remote path '${canonical}' is already registered on '${owner.host}'; one workspace record cannot serve two machines`)
    }
    if (owner !== undefined) {
      await remember(state, colliding, input.host, canonical)
      return colliding
    }
    throw new Error(`path '${canonical}' is already a local workspace; remote adoption of the same path is ambiguous`)
  }

  const entity = await registry.enqueueOperation(() => registry.createCanonical(canonical, input.title))
  patchEntityPrototype(Object.getPrototypeOf(entity) as object, state)
  await remember(state, entity, input.host, canonical)
  return entity
}

/** Persist one attribution record for a workspace entity. */
async function remember(state: RemoteWorkspaceState, entity: WorkspaceEntityLike, host: string, path: string): Promise<RemoteWorkspaceRecord> {
  const record: RemoteWorkspaceRecord = {
    workspaceId: String(entity.id),
    host,
    path,
    title: entity.title,
    createdAt: new Date().toISOString(),
  }
  await state.put(record)
  return record
}
