/** One authenticated daemon client session: private services plus its RPC dispatch. */
import { existsSync } from 'node:fs'
import { realpath, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { Readable, Writable } from 'node:stream'
import type { FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { RemoteOperationError, RpcPeer } from '@dsh-ssh-workspace/rpc'
import { z } from 'zod'
import { RemoteProcessOwner } from './processes.ts'
import { parsePrepare } from './wire.ts'
import {
  editSchema, environmentSchema, intentSchema, MAX_TEXT_STREAMS, policySchema,
  remotePath, targetSchema, textStreamIdSchema,
} from './schemas.ts'

const MAX_FRAME_BYTES = 64 * 1024 * 1024
const MAX_TEXT_BYTES = 8 * 1024 * 1024
const object = z.object({}).strict()
const textStreamIdRequest = z.object({ id: textStreamIdSchema }).strict()

export interface DaemonOptions {
  /** Absolute daemon state directory (socket, pid, per-process stream dirs). */
  readonly dir: string
  /** Workspace whitelist roots; a hello workspace must canonicalize under one. */
  readonly roots: readonly string[]
  /** Default sandbox mode for mounted service contexts. */
  readonly defaultMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Outstanding process-handle limit (reap event ③). */
  readonly maxProcessHandles: number
  /** Monotonic boot token shared by every live session of this daemon run. */
  readonly instanceId: string
  /** Spill reporter accepts the daemon's owned label plus the spill error. */
  readonly spillFailure: (error: unknown) => void
}

/** Most recent explicit whitelist entries kept in `config.json`. */
const MAX_ALLOWED_ROOTS = 64

/** Per-client-uuid session surviving transport loss within one daemon boot. */
interface ClientSession {
  readonly uuid: string
  readonly workspace: string
  readonly ctx: Context
  readonly owner: RemoteProcessOwner
  readonly fibers: Array<{ dispose(): Promise<void> }>
  readonly iterators: Map<string, { iterator: AsyncIterator<string>; controller: AbortController }>
  /** opId → sticky write/edit result: a replayed durable write never mutates twice. */
  readonly writeMemo: Map<string, unknown>
  pruneMemo(): void
  /** Whether the owning transport is currently disconnected. */
  detached: boolean
  detach(): void
  attach(): void
  dispose(): Promise<void>
}

async function mountServices(workspace: string, defaultMode: DaemonOptions['defaultMode']): Promise<{ ctx: Context; fibers: Array<{ dispose(): Promise<void> }> }> {
  const ctx = new Context()
  const fibers: Array<{ dispose(): Promise<void> }> = []
  fibers.push(await ctx.plugin(SessionProjectionRegistry))
  fibers.push(await ctx.plugin(SandboxPolicyService, { mode: defaultMode, workspaceRoot: workspace }))
  fibers.push(await ctx.plugin(SandboxedFileSystem, { cwd: workspace }))
  fibers.push(await ctx.plugin(LocalSubprocessRuntime))
  fibers.push(await ctx.plugin(LocalSandboxProvider))
  return { ctx, fibers }
  function workspaceRoot(): string { return workspace }
}

/** Dispatch one daemon client connection: handshake, mount, serve until EOF. */
export async function serveConnection(
  socket: Duplex,
  options: DaemonOptions,
  registry: ClientRegistry,
): Promise<void> {
  let session: ClientSession | undefined
  const peer = new RpcPeer(socket as unknown as Readable, socket as unknown as Writable, MAX_FRAME_BYTES, 128, async (method, raw, signal) => {
    if (method === 'hello') {
      const input = z.object({
        protocol: z.literal(1), workspace: remotePath, clientUuid: z.string().regex(/^[0-9a-zA-Z-]{8,64}$/),
        instanceId: z.string().optional(),
      }).strict().parse(raw)
      if (!(await registry.approvesWorkspace(input.workspace))) {
        throw new RemoteOperationError(`workspace '${input.workspace}' is outside the daemon whitelist`, 'WORKSPACE_NOT_ALLOWED')
      }
      const prior = await registry.get(input.clientUuid)
      if (prior !== undefined) {
        if (prior.workspace !== input.workspace) throw new Error('workspace daemon session identity mismatch')
        if (input.instanceId !== undefined && input.instanceId !== options.instanceId) {
          throw new RemoteOperationError(
            'workspace daemon restarted; in-flight progress of the previous instance is no longer available',
            'WORKSPACE_PROGRESS_LOST',
          )
        }
        session = session === undefined || session === prior ? prior : session
      } else {
        session = session ?? await registry.create(input.clientUuid, input.workspace)
      }
      session.attach()
      const ripgrep = join(options.dir, 'bin', `rg-${process.platform}-${process.arch}`)
      return {
        protocol: 1, platform: process.platform as 'linux' | 'darwin', arch: process.arch, nodeVersion: process.version,
        executable: process.execPath, root: options.dir, workspace: session.workspace,
        instanceId: options.instanceId, kind: 'daemon', rg: existsSync(ripgrep) ? ripgrep : null,
      }
    }
    if (method === 'workspace.allow') {
      // Explicit, user-initiated opt-in: the caller names one directory it may
      // then open a session on. The socket is 0600 and owned by this user, so
      // whoever can reach it already has the daemon's full power; this gate
      // guards against accidents, not against other local accounts.
      const input = z.object({ path: remotePath }).strict().parse(raw)
      return await registry.allow(input.path)
    }
    if (session === undefined) throw new Error('workspace daemon session is not initialized')
    return await dispatch(method, raw, signal, session, registry)
  })
  const closed = Promise.withResolvers<void>()
  peer.once('closed', () => {
    // Transport loss is NOT an event that may reclaim anything (D7): the
    // session detaches and stays resident, its processes keep running, and
    // bounded output keeps accumulating in each stream's replay window. Only
    // explicit events reclaim it: daemon shutdown (①), an explicit close or
    // terminate (②), or the outstanding-handle limit (③).
    if (session !== undefined) session.detach()
    closed.resolve()
  })
  await closed.promise
}

async function dispatch(method: string, raw: unknown, signal: AbortSignal, session: ClientSession, registry: ClientRegistry): Promise<unknown> {
  const { ctx, owner, iterators, writeMemo } = session
  switch (method) {
    case 'heartbeat': { object.parse(raw); return null }
    case 'session.reattach': {
      object.parse(raw)
      return { workspace: session.workspace }
    }
    case 'stream.present': {
      // A client re-attaching a durable stream asks whether its endpoint still
      // exists: absent means the process was released and re-attaching forever
      // would only burn SSH forwards.
      const input = z.object({ path: remotePath }).strict().parse(raw)
      return { present: await owner.present(input.path) }
    }
    case 'close': { object.parse(raw); return null }
    case 'executable': {
      const input = z.object({ command: z.string(), env: environmentSchema.optional() }).strict().parse(raw)
      const env = input.env === undefined ? undefined : Object.fromEntries(
        Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== null),
      )
      try {
        return await ctx.subprocess.resolveExecutable(input.command, env, signal)
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'SubprocessExecutableNotFoundError') {
          throw new RemoteOperationError(String((error as { message?: unknown }).message ?? 'executable not found'), 'SUBPROCESS_EXECUTABLE_NOT_FOUND')
        }
        throw error
      }
    }
    case 'terminal.environment': {
      object.parse(raw)
      return terminalEnvironment()
    }
    case 'sandbox': {
      const input = z.object({ argv: z.array(z.string()).min(1), policy: policySchema }).strict().parse(raw)
      const resolved = await canonicalPolicy(input.policy, ctx, signal)
      if ((resolved.mode as string) === 'danger-full-access') throw new Error('Unconfined argv does not need a sandbox wrapper')
      return ctx.sandbox.confine(input.argv, resolved as SandboxPolicy, signal)
    }
    case 'process.prepare': {
      // Reap event ③ also covers detached, process-less sessions: a client
      // that reconnected and re-prepared must not accumulate dead sessions.
      // It runs off the request path, because a stale session's own disposal
      // may legitimately stall on a child that ignores SIGTERM.
      void registry.reapDetached(session.uuid)
      const { spawn, opId } = parsePrepare(raw)
      return await owner.prepare(spawn, opId)
    }
    case 'process.start': {
      const input = z.object({ id: z.string(), opId: z.string().optional() }).strict().parse(raw)
      return await owner.start(input.id as never, signal)
    }
    case 'process.done': {
      const { id } = z.object({ id: z.string() }).strict().parse(raw)
      return await owner.done(id as never)
    }
    case 'process.wait': {
      const { id } = z.object({ id: z.string() }).strict().parse(raw)
      return await owner.wait(id as never, signal)
    }
    case 'process.terminate': {
      const input = z.object({ id: z.string(), abandon: z.boolean().optional() }).strict().parse(raw)
      await owner.terminate(input.id as never, input.abandon ?? false)
      return null
    }
    case 'terminal.resize': {
      const input = z.object({ id: z.string(), cols: z.number().int().positive(), rows: z.number().int().positive() }).strict().parse(raw)
      await owner.resizeTerminal(input.id as never, input.cols, input.rows)
      return null
    }
    case 'terminal.write': case 'terminal.inspect': case 'terminal.activity': case 'terminal.signal': {
      const input = z.object({ id: z.string(), value: z.string().optional(), opId: z.string().optional() }).strict().parse(raw)
      const operation = method === 'terminal.write' ? 'write' : method === 'terminal.inspect' ? 'inspect' : method === 'terminal.activity' ? 'activity' : 'signal'
      if (operation === 'write' && input.opId !== undefined) {
        const memo = `tw:${input.id}:${input.opId}`
        if (!writeMemo.has(memo)) {
          await owner.terminal(input.id as never, 'write', input.value)
          writeMemo.set(memo, null)
          session.pruneMemo()
        }
        return null
      }
      return await owner.terminal(input.id as never, operation, input.value)
    }
    case 'fs.resolve': case 'fs.lstat': {
      const input = z.object({ path: z.string(), cwd: remotePath.optional() }).strict().parse(raw)
      return method === 'fs.resolve'
        ? ctx.fs.resolve(input.path, { cwd: input.cwd, signal })
        : await ctx.fs.lstat(input.path, { cwd: input.cwd }, signal) ?? null
    }
    case 'fs.stat': case 'fs.list': case 'fs.readText': case 'fs.stream': {
      const target = asTarget(z.object({ target: targetSchema }).strict().parse(raw).target)
      if (method === 'fs.stat') return await ctx.fs.stat(target, signal) ?? null
      if (method === 'fs.list') return ctx.fs.listDir(target, signal)
      if (method === 'fs.stream') {
        if (iterators.size >= MAX_TEXT_STREAMS) throw new Error('workspace daemon text stream limit reached')
        const controller = new AbortController()
        const stream = await ctx.fs.streamText(target, AbortSignal.any([signal, controller.signal]))
        const iterator = stream[Symbol.asyncIterator]()
        try {
          signal.throwIfAborted()
          const id = randomUUID()
          iterators.set(id, { iterator, controller })
          return id
        } catch (error) {
          controller.abort(error)
          await iterator.return?.()
          throw error
        }
      }
      const stream = await ctx.fs.streamText(target, signal)
      let text = ''
      let bytes = 0
      for await (const chunk of stream) {
        bytes += Buffer.byteLength(chunk)
        if (bytes > MAX_TEXT_BYTES) {
          throw remoteError('workspace daemon whole-text transfer exceeds its budget; use streaming', 'FS_TOO_LARGE')
        }
        text += chunk
      }
      return text
    }
    case 'fs.next': case 'fs.streamClose': {
      const { id } = textStreamIdRequest.parse(raw)
      const record = iterators.get(id)
      if (record === undefined) throw new Error('Unknown workspace daemon text stream')
      if (method === 'fs.streamClose') {
        iterators.delete(id)
        record.controller.abort(new Error('workspace daemon text stream closed'))
        await record.iterator.return?.()
        return null
      }
      const abort = (): void => { record.controller.abort(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      try {
        signal.throwIfAborted()
        const next = await record.iterator.next()
        if (next.done) iterators.delete(id)
        return { done: next.done ?? false, value: next.done ? '' : next.value }
      } catch (error) {
        iterators.delete(id)
        record.controller.abort(error)
        await record.iterator.return?.()
        throw error
      } finally { signal.removeEventListener('abort', abort) }
    }
    case 'fs.readBytes': case 'fs.readRange': {
      const input = z.object({
        target: targetSchema, maxBytes: z.number().int().nonnegative().optional(),
        offset: z.number().int().nonnegative().optional(), length: z.number().int().nonnegative().optional(),
      }).strict().parse(raw)
      const target = asTarget(input.target)
      const bytes = method === 'fs.readBytes'
        ? await ctx.fs.readBytes(target, signal, Math.min(input.maxBytes ?? MAX_TEXT_BYTES, MAX_TEXT_BYTES))
        : await ctx.fs.readByteRange(target, {
          offset: input.offset ?? 0,
          length: Math.min(input.length ?? MAX_TEXT_BYTES, MAX_TEXT_BYTES),
        }, signal)
      return Buffer.from(bytes).toString('base64')
    }
    case 'fs.write': case 'fs.edit': {
      const input = z.object({
        target: targetSchema, content: z.string().optional(), edit: editSchema.optional(),
        expected: z.union([intentSchema, z.object({ version: z.string() }).strict()]).optional(),
        policy: policySchema, opId: z.string().optional(),
      }).strict().parse(raw)
      const target = asTarget(input.target)
      const expected = 'kind' in (input.expected ?? {}) ? intentSchema.parse(input.expected) as FsWriteIntent : input.expected
      if (input.opId !== undefined) {
        const memo = writeMemo.get(`${method}:${input.opId}`)
        if (memo !== undefined) return memo
      }
      const resolved = await canonicalPolicy(input.policy, ctx, signal)
      const outcome = method === 'fs.write'
        ? await ctx.fs.writeText(target, input.content ?? '', expected as FsWriteIntent | undefined, signal, resolved as never)
        : await ctx.fs.editText(target, editSchema.parse(input.edit), expected as { version: FsVersion } | undefined, signal, resolved as never)
      if (input.opId !== undefined) {
        writeMemo.set(`${method}:${input.opId}`, JSON.parse(JSON.stringify(outcome)))
        session.pruneMemo()
      }
      return outcome
    }
    default: throw new Error(`Unknown workspace daemon operation: ${method}`)
  }
}

const asTarget = (raw: unknown): FsTarget => targetSchema.parse(raw) as FsTarget
const remoteError = (message: string, code: string): RemoteOperationError => new RemoteOperationError(message, code)

/** Terminal facts the published SSH providers expect, resolved locally. */
function terminalEnvironment(): { platform: 'posix' | 'windows', defaultShell?: string } {
  const platform = process.platform === 'win32' ? 'windows' as const : 'posix' as const
  const shell = (platform === 'windows' ? process.env.ComSpec : process.env.SHELL ?? userInfo().shell) ?? undefined
  return { platform, ...shell === undefined || shell === '' ? {} : { defaultShell: shell } }
}

async function canonicalPolicy(policy: z.output<typeof policySchema>, ctx: Context, signal: AbortSignal): Promise<SandboxPolicy> {
  const target = await ctx.fs.resolve(policy.workspaceRoot, { signal })
  return { ...policy, workspaceRoot: ctx.fs.processPath(target) } as SandboxPolicy
}

function constructSession(
  uuid: string, workspace: string, owner: RemoteProcessOwner, ctx: Context,
  fibers: Array<{ dispose(): Promise<void> }>, registry: ClientRegistry,
): ClientSession {
  let disposed = false
  const session: ClientSession = {
    uuid, workspace, ctx, owner, fibers,
    iterators: new Map(),
    writeMemo: new Map(),
    detached: true,
    detach(): void { session.detached = true },
    attach(): void { session.detached = false },
    pruneMemo(): void {
      while (session.writeMemo.size > 512) session.writeMemo.delete(session.writeMemo.keys().next().value as string)
    },
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      registry.drop(uuid)
      try {
        for (const record of [...this.iterators.values()]) {
          record.controller.abort(new Error('workspace daemon session disposed'))
          await record.iterator.return?.()
        }
        this.iterators.clear()
      } finally {
        try { await this.owner.close() }
        finally { for (const fiber of [...this.fibers].reverse()) await fiber.dispose() }
      }
    },
  }
  return session
}

// Mutable binding the session factory uses for disposal bookkeeping.
let registry: ClientRegistry

/** Registry of per-client-uuid sessions surviving transport loss within one daemon boot. */
export class ClientRegistry {
  private readonly sessions = new Map<string, Promise<ClientSession>>()

  constructor(options: DaemonOptions) {
    registry = this
    this.options = options
    this.roots = [...options.roots]
  }

  private readonly options: DaemonOptions

  /** Mutable whitelist: the boot roots plus every directory a client allowed. */
  private readonly roots: string[]


  async get(uuid: string): Promise<ClientSession | undefined> {
    const pending = this.sessions.get(uuid)
    if (pending === undefined) return undefined
    try { return await pending } catch { return undefined }
  }

  /** Whether a hello workspace lies under the daemon whitelist. */
  async approvesWorkspace(workspace: string): Promise<boolean> {
    return this.underRoot(workspace)
  }

  /** Whether one path lies under the current whitelist. */
  private underRoot(workspace: string): boolean {
    for (const root of this.roots) {
      if (workspace === root || workspace.startsWith(`${root === '/' ? '' : root}/`)) return true
    }
    return false
  }

  /**
   * Add one directory to the whitelist and persist it, so a workspace the user
   * adds from the browser stays usable across daemon restarts. The list keeps
   * only the most recent entries, because each is a deliberate local opt-in,
   * not an unbounded audit log.
   * @param path - directory to allow, canonicalized with `realpath`.
   * @returns the whitelist after the update.
   */
  async allow(path: string): Promise<{ roots: readonly string[] }> {
    const canonical = await realpath(path).catch(() => resolve(path))
    if (!this.underRoot(canonical)) {
      this.roots.push(canonical)
      while (this.roots.length > MAX_ALLOWED_ROOTS) this.roots.shift()
      await this.persist()
    }
    return { roots: this.roots }
  }

  /** Write the whitelist (and the current mode) back to `config.json`. */
  private async persist(): Promise<void> {
    const body = JSON.stringify({
      roots: this.roots,
      defaultMode: this.options.defaultMode,
      maxProcessHandles: this.options.maxProcessHandles,
    })
    await writeFile(join(this.options.dir, 'config.json'), `${body}\n`).catch(() => {})
  }

  async create(uuid: string, workspace: string): Promise<ClientSession> {
    const pending = this.sessions.get(uuid)
    if (pending !== undefined) return await pending
    const created = (async (): Promise<ClientSession> => {
      const { ctx, fibers } = await mountServices(workspace, this.options.defaultMode)
      const owner = new RemoteProcessOwner(ctx, join(this.options.dir, 'streams'), this.options.maxProcessHandles, this.options.spillFailure)
      return constructSession(uuid, workspace, owner, ctx, fibers, this)
    })()
    this.sessions.set(uuid, created)
    void created.then(() => {}, () => { this.sessions.delete(uuid) })
    return await created
  }

  drop(uuid: string): void { this.sessions.delete(uuid) }

  /**
   * Reclaim sessions that have detached and own no processes (reap event ③).
   * Bounded and never blocking a caller: disposal of a session whose child
   * ignores SIGTERM must not wedge an unrelated request.
   * @param keep - uuid of the asking session, never reclaimed here.
   * @param budgetMs - per-session disposal budget before the attempt is abandoned.
   */
  async reapDetached(keep?: string, budgetMs = 5000): Promise<void> {
    const entries = await Promise.allSettled([...this.sessions.values()])
    for (const entry of entries) {
      if (entry.status !== 'fulfilled') continue
      const session = entry.value
      if (session.uuid === keep || !session.detached || session.owner.size > 0) continue
      await Promise.race([
        session.dispose().catch(() => {}),
        new Promise<void>((resolve) => { setTimeout(resolve, budgetMs).unref() }),
      ])
    }
  }

  get size(): number { return this.sessions.size }

  /** Resolved sessions of this daemon boot, used at shutdown. */
  async all(): Promise<ClientSession[]> {
    const settled = await Promise.allSettled([...this.sessions.values()])
    return settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  }
}
