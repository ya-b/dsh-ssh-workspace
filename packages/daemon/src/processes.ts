/** Durable remote process ownership: opId idempotency, reconnectable streams, explicit-only reap. */
import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { Duplex, Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { OutputCollector, prepareManagedProcessBinding, type SpillFailureReporter } from '@deepseek-ai/dsh-subprocess-local/output'
import { RemoteOperationError, RpcPeer } from '@dsh-ssh-workspace/rpc'
import { z } from 'zod'
import { createEndpoint, prepareDirectory, ReplayBuffer, type Channel, type Endpoint } from './endpoints.ts'
import { doneSchema, outputSnapshotFrameLimit, spawnSchema, type SshStreamEndpoint } from './schemas.ts'

export type ProcessId = string
type Request = z.infer<typeof spawnSchema>
type Completion = z.infer<typeof doneSchema>

/** 1 MiB per stream: the reconnect window the plan fixes for buffered output. */
const REPLAY_BYTES = 1024 * 1024

interface ProcessRecord {
  readonly id: ProcessId
  request: Request
  /** Client-provided 128-bit idempotency key, present for durable resubmission. */
  opId?: string
  endpoints: Partial<Record<Channel, Endpoint>>
  controller: AbortController
  ordinary?: SubprocessHandle
  terminal?: SubprocessTerminalHandle
  start?: Promise<{ pid?: number }>
  startResult?: { pid?: number }
  /** First start failure, kept so a replayed start can surface it as a typed error. */
  startError?: unknown
  done?: Promise<Completion>
  /** Creation order for oldest-first explicit reap. */
  readonly created: number
}

/** Settled process record removed from live ownership but still queryable. */
interface CompletedRecord {
  readonly done: Promise<Completion>
  readonly startResult: { pid?: number }
  /** Present when start never produced a result: a replayed start must fail, not look successful. */
  readonly startFailure?: { readonly message: string; readonly code: string }
  readonly opId: string | undefined
}

const processIdRequest = z.object({ id: z.string() }).strict()

/** Push collector snapshots to the attached client while capture continues independently. */
class SnapshotForwarder {
  private readonly collector: OutputCollector
  private readonly maxBytes: number
  private peer: RpcPeer | undefined
  private dirty = false
  private running: Promise<void> | undefined
  private stopped = false
  private socket: import('node:net').Socket | undefined

  constructor(collector: OutputCollector, maxBytes: number) {
    this.collector = collector
    this.maxBytes = maxBytes
  }

  attach(socket: import('node:net').Socket): void {
    if (this.socket === socket) return
    this.socket = socket
    this.peer?.close()
    this.stopped = false
    this.peer = new RpcPeer(socket, socket, outputSnapshotFrameLimit(this.maxBytes))
    this.peer.once('closed', () => { this.running = undefined; this.dirty = false })
    this.offer()
  }

  offer(): void {
    if (this.stopped || this.peer === undefined) return
    this.dirty = true
    this.running ??= this.flush()
  }

  private async flush(): Promise<void> {
    try {
      while (this.dirty && !this.stopped && this.peer !== undefined) {
        this.dirty = false
        const snapshot = this.collector.snapshot()
        await this.peer.request('snapshot', { tail: snapshot.bytes.toString('base64'), totalBytes: snapshot.totalBytes }, z.null())
      }
    } catch { this.stopped = true; this.peer?.close() }
    finally { this.running = undefined }
  }
}

/** Map a start that never produced a result to the typed error a replay must see. */
function startFailure(record: ProcessRecord): { message: string; code: string } {
  if (record.controller.signal.aborted) {
    return {
      message: 'workspace daemon process start was cancelled before the process was created',
      code: 'PROCESS_START_CANCELLED',
    }
  }
  const message = record.startError instanceof Error ? record.startError.message : String(record.startError ?? 'workspace daemon process start failed')
  return { message, code: 'PROCESS_START_FAILED' }
}

/**
 * Owns every daemon process range. Unlike the official SSH helper this owner
 * survives transport loss: there is no lease and no heartbeat sweep. Records
 * are reclaimed only by explicit events — daemon shutdown (①), an explicit
 * terminate/abandon (②), or the outstanding-handle limit (③: completed
 * records evicted first, then the oldest running records terminated
 * SIGTERM-first).
 */
export class RemoteProcessOwner {
  private readonly records = new Map<ProcessId, ProcessRecord>()
  private readonly byOpId = new Map<string, ProcessId>()
  private readonly completed = new Map<ProcessId, CompletedRecord>()
  private closing = false

  constructor(
    private readonly ctx: Context,
    private readonly root: string,
    private readonly limit: number,
    private readonly reportSpillFailure: SpillFailureReporter,
  ) {}

  /** Live (not yet settled) handled processes; the reap limit applies to these. */
  get size(): number { return this.records.size }

  /**
   * Whether a published stream endpoint still exists. Completed processes
   * close their endpoints (and remove every socket path), so a client chasing
   * one would otherwise re-attach forever.
   * @param path - absolute endpoint path from a preparation.
   */
  async present(path: string): Promise<boolean> {
    if (!path.startsWith(`${this.root}/`)) return false
    try { await access(path); return true } catch { return false }
  }

  /**
   * Allocate private stream listeners; no target executes until start().
   * A repeated opId returns the same reservation — never a second process —
   * and a finished opId returns its cached terminal observation instead.
   */
  async prepare(raw: unknown, opId?: string): Promise<unknown> {
    if (opId !== undefined) {
      const existing = this.byOpId.get(opId)
      if (existing !== undefined) {
        // A completed reservation answers with its id and no streams: the
        // official prepared schema is strict, and start/done remain queryable
        // from the completion cache.
        if (this.completed.has(existing)) return { id: existing, streams: {} }
        return this.describe(existing)
      }
    }
    const request = spawnSchema.parse(raw)
    if (this.records.size >= this.limit) await this.reap()
    if (this.closing) throw new Error('workspace daemon is closing')
    if (this.records.size >= this.limit) throw new Error('workspace daemon process capacity unavailable')
    const id = randomUUID() as ProcessId
    const record: ProcessRecord = {
      id, request, endpoints: {}, controller: new AbortController(),
      created: Date.now(), ...(opId === undefined ? {} : { opId }),
    }
    this.records.set(id, record)
    if (opId !== undefined) this.byOpId.set(opId, id)
    try {
      const directory = join(this.root, id)
      await prepareDirectory(directory)
      record.controller.signal.throwIfAborted()
      const names: Channel[] = request.terminal === undefined
        ? ['stdout', 'stderr', ...(request.stdio?.stdin === 'pipe' ? ['stdin' as const] : []), ...(request.stdio?.control === 'pipe' ? ['control' as const] : [])]
        : ['terminal']
      for (const name of names) {
        // stdin/control are client→daemon; replay applies to daemon→client
        // channels (stdout, stderr, terminal) so a reconnect resumes at the
        // client's acknowledged byte offset.
        const replay = name === 'stdin' || name === 'control' ? undefined : new ReplayBuffer(REPLAY_BYTES)
        record.endpoints[name] = await createEndpoint(directory, name, replay === undefined ? {} : { replay })
        record.controller.signal.throwIfAborted()
      }
      return this.describe(id)
    } catch (error) {
      void this.release(id).catch(() => {})
      throw error
    }
  }

  private describe(id: ProcessId): { id: ProcessId; streams: Partial<Record<Channel, SshStreamEndpoint>> } {
    const record = this.record(id)
    return { id, streams: Object.fromEntries(Object.entries(record.endpoints).map(([name, endpoint]) =>
      [name, { path: endpoint.path, capability: endpoint.capability }])) }
  }

  /**
   * Start once all data channels are authenticated; repeated invocation (a
   * reconnecting transport replaying its launch request) returns the first
   * result instead of spawning twice.
   */
  async start(id: ProcessId, signal?: AbortSignal): Promise<{ pid?: number }> {
    const completed = this.completed.get(id)
    if (completed !== undefined) {
      if (completed.startFailure !== undefined) {
        throw new RemoteOperationError(completed.startFailure.message, completed.startFailure.code)
      }
      return completed.startResult
    }
    const record = this.record(id)
    if (record.startResult !== undefined) return record.startResult
    if (record.start !== undefined) return await record.start
    signal?.throwIfAborted()
    const abort = (): void => { record.controller.abort(signal?.reason) }
    signal?.addEventListener('abort', abort, { once: true })
    record.start = this.startOnce(record)
    try {
      record.startResult = await record.start
      return record.startResult
    } catch (error) {
      record.startError = error
      const failed = Promise.reject<Completion>(error)
      void failed.catch(() => {})
      record.done = failed
      await this.finishFailed(record, failed)
      throw error
    } finally { signal?.removeEventListener('abort', abort) }
  }

  private async startOnce(record: ProcessRecord): Promise<{ pid?: number }> {
    await Promise.all(Object.values(record.endpoints).map(endpoint => endpoint.attached()))
    if (this.closing) throw new Error('workspace daemon is closing')
    record.controller.signal.throwIfAborted()
    const request = record.request
    const cwd = this.ctx.fs.processPath(await this.ctx.fs.resolve(request.cwd, { signal: record.controller.signal }))
    record.controller.signal.throwIfAborted()
    const env = request.env === undefined ? {} : Object.fromEntries(
      Object.entries(request.env).map(([key, value]) => [key, value ?? undefined]),
    )
    if (request.terminal !== undefined) return await this.startTerminal(record, request, cwd, env)
    return await this.startOrdinary(record, request, cwd, env)
  }

  private async startTerminal(
    record: ProcessRecord, request: Request, cwd: string,
    env: Record<string, string | undefined>,
  ): Promise<{ pid?: number }> {
    const terminal = await this.ctx.subprocess.spawnTerminal({
      argv: request.argv, cwd,
      env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      graceMs: request.graceMs, ...request.terminal!,
      signal: record.controller.signal,
    })
    record.terminal = terminal
    record.controller.signal.throwIfAborted()
    const endpoint = record.endpoints.terminal as Endpoint
    let paused = false
    endpoint.onDrain(() => { if (paused) { paused = false; terminal.output.resume() } })
    terminal.output.on('data', (chunk: Buffer) => {
      if (!endpoint.feed(chunk) && !paused) { paused = true; terminal.output.pause() }
    })
    const done = terminal.done.then(outcome => ({ outcome, spills: {}, collected: {} }))
    record.done = done
    void done.then(async () => {
      if (request.terminal?.shellActivity !== true) await terminal.terminate()
      await this.rememberCompleted(record, done)
    }, () => this.finishFailed(record, done)).catch(() => {})
    return { pid: terminal.pid }
  }

  private async startOrdinary(
    record: ProcessRecord, request: Request, cwd: string,
    env: Record<string, string | undefined>,
  ): Promise<{ pid?: number }> {
    const stdio = request.stdio as NonNullable<Request['stdio']>
    const ordinary = this.ctx.subprocess.spawn({
      argv: request.argv, cwd, env, graceMs: request.graceMs, signal: record.controller.signal,
      stdio: { stdin: stdio.stdin, stdout: 'pipe', stderr: 'pipe', ...(stdio.control === undefined ? {} : { control: stdio.control }) },
    })
    record.ordinary = ordinary
    const control = ordinary.control
    if (record.endpoints.control !== undefined && control === undefined) {
      void ordinary.done.catch(() => {})
      throw new Error('Remote subprocess provider did not establish fd 7')
    }
    const collectors: Partial<Record<'stdout' | 'stderr', OutputCollector>> = {}
    const forwarders: Partial<Record<'stdout' | 'stderr', SnapshotForwarder>> = {}
    const stopCapture: Array<() => void> = []
    for (const name of ['stdout', 'stderr'] as const) {
      const stream = ordinary[name] as Readable
      const mode = stdio[name]
      const endpoint = record.endpoints[name] as Endpoint
      if (typeof mode === 'object') {
        const binding = prepareManagedProcessBinding({ onSpillFailure: this.reportSpillFailure })
        const collector = new OutputCollector(mode.maxBytes, name, mode.spill === undefined ? undefined : {
          maxBytes: mode.spill.maxBytes, dir: binding.spillDir, onFailure: binding.onSpillFailure,
        })
        collectors[name] = collector
        const forwarder = new SnapshotForwarder(collector, mode.maxBytes)
        forwarders[name] = forwarder
        endpoint.onAttach(socket => { forwarder.attach(socket) })
        const receive = (chunk: Buffer): void => { collector.push(chunk); forwarder.offer() }
        stream.on('data', receive)
        stopCapture.push(() => { stream.off('data', receive); stream.destroy(); collector.seal() })
      } else {
        let paused = false
        endpoint.onDrain(() => { if (paused) { paused = false; stream.resume() } })
        const receive = (chunk: Buffer): void => {
          if (!endpoint.feed(chunk) && !paused) { paused = true; stream.pause() }
        }
        stream.on('data', receive)
        stopCapture.push(() => { stream.off('data', receive); stream.destroy() })
      }
    }
    if (record.endpoints.stdin !== undefined) {
      const stdinEndpoint = record.endpoints.stdin as Endpoint
      const wire = (socket: import('node:net').Socket): void => {
        socket.end()
        void pipeline(socket, ordinary.stdin as Writable).catch(() => {})
      }
      stdinEndpoint.onAttach(wire)
    }
    if (record.endpoints.control !== undefined) {
      const channel = control as Duplex
      const controlEndpoint = record.endpoints.control as Endpoint
      controlEndpoint.onAttach((socket) => {
        socket.pipe(channel).pipe(socket)
        socket.on('error', () => { channel.destroy() })
        channel.on('error', () => { socket.destroy() })
      })
    }
    const done = ordinary.done.finally(() => {
      for (const stop of stopCapture) stop()
    }).then(async (outcome) => {
      const spills: { stdout?: string; stderr?: string } = {}
      const collected: Completion['collected'] = {}
      for (const name of ['stdout', 'stderr'] as const) {
        const collector = collectors[name]
        if (collector === undefined) continue
        const snapshot = collector.snapshot()
        collected[name] = { tail: snapshot.bytes.toString('base64'), totalBytes: snapshot.totalBytes }
        const path = collector.readFrom(0).spillPath
        if (path !== undefined) spills[name] = path
      }
      return { outcome, spills, collected }
    })
    record.done = done
    void done.then(async () => {
      await ordinary.waitForExit()
      await this.rememberCompleted(record, done)
    }, () => this.finishFailed(record, done)).catch(() => {})
    return {}
  }

  /** Await the direct result without claiming all descendants have exited. */
  async done(id: ProcessId): Promise<unknown> {
    const completed = this.completed.get(id)
    if (completed !== undefined) return completed.done
    const record = this.record(id)
    if (record.done === undefined) throw new Error('workspace daemon process has not started')
    return record.done
  }

  /** Observe whether the managed range is empty; observation loss keeps ownership. */
  async wait(id: ProcessId, signal?: AbortSignal): Promise<boolean> {
    if (this.completed.has(id)) return true
    const record = this.record(id)
    if (record.start === undefined && record.startResult === undefined) throw new Error('workspace daemon process was not started')
    if (record.ordinary !== undefined) return record.ordinary.waitForExit(signal)
    if (record.terminal !== undefined) { await record.terminal.terminate(); return true }
    await (record.start ?? record.startResult)
    throw new Error('workspace daemon process was not started')
  }

  /**
   * Explicit reap event ②: terminate the process and await quiescence. The
   * retained completion stays queryable; `abandon` also drops the record so a
   * later prepare with the same opId would refuse instead of reusing it.
   */
  async terminate(id: ProcessId, abandon = false): Promise<void> {
    if (this.completed.has(id)) {
      if (abandon) {
        const completed = this.completed.get(id)
        this.completed.delete(id)
        if (completed?.opId !== undefined && this.byOpId.get(completed.opId) === id) this.byOpId.delete(completed.opId)
      }
      return
    }
    const record = this.records.get(id)
    if (record === undefined) return
    record.controller.abort(new Error('workspace daemon process termination requested'))
    record.ordinary?.terminate()
    if (record.ordinary !== undefined) await record.ordinary.waitForExit()
    if (record.terminal !== undefined) {
      await record.terminal.terminate()
      if (record.request.terminal?.shellActivity === true && record.done !== undefined) {
        await this.rememberCompleted(record, record.done)
      }
    }
    if (record.ordinary === undefined && record.terminal === undefined) await this.release(id)
  }

  /** Explicit reap event ③: enforce the outstanding-handle limit. */
  async reap(): Promise<void> {
    while (this.completed.size > this.limit * 2) {
      const oldest = this.completed.keys().next().value
      if (oldest === undefined) break
      await this.abandonCompleted(oldest)
    }
    while (this.records.size >= this.limit) {
      const oldest = [...this.records.entries()]
        .filter(([, record]) => record.start !== undefined || record.startResult !== undefined)
        .sort((left, right) => left[1].created - right[1].created)[0]?.[0]
      if (oldest === undefined) break
      await this.terminate(oldest)
    }
  }

  private async abandonCompleted(id: ProcessId): Promise<void> {
    const completed = this.completed.get(id)
    this.completed.delete(id)
    if (completed?.opId !== undefined && this.byOpId.get(completed.opId) === id) this.byOpId.delete(completed.opId)
  }

  /** Terminal input, foreground observation, activity, or delivery; input dedupes by opId. */
  async terminal(id: ProcessId, operation: 'write' | 'inspect' | 'activity' | 'signal', value?: string): Promise<unknown> {
    const terminal = this.record(id).terminal
    if (terminal === undefined) throw new Error('workspace daemon handle does not own a terminal')
    if (operation === 'write') return await terminal.write(z.string().parse(value)) as unknown
    if (operation === 'inspect') return await terminal.inspectForeground() ?? null
    if (operation === 'activity') return terminal.inspectActivity()
    return terminal.signalForeground(z.enum(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP']).parse(value))
  }

  async resizeTerminal(id: ProcessId, cols: number, rows: number): Promise<void> {
    const terminal = this.record(id).terminal
    if (terminal === undefined) throw new Error('workspace daemon handle does not own a terminal')
    await terminal.resize(cols, rows)
  }

  /** Explicit reap event ①: daemon shutdown releases every owned process. */
  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    const outcomes = await Promise.allSettled([...this.records.keys()].map(id => this.terminate(id)))
    const errors = outcomes.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
    if (errors.length > 0) throw new AggregateError(errors, 'workspace daemon process cleanup failed')
  }

  private async release(id: ProcessId): Promise<void> {
    const record = this.records.get(id)
    if (record === undefined) return
    record.controller.abort(new Error('workspace daemon process reservation closed'))
    record.ordinary?.terminate()
    if (record.ordinary !== undefined) await record.ordinary.waitForExit().catch(() => {})
    if (record.terminal !== undefined) await record.terminal.terminate().catch(() => {})
    await Promise.all(Object.values(record.endpoints).map(endpoint => endpoint.close()))
    this.records.delete(id)
    if (record.opId !== undefined && this.byOpId.get(record.opId) === id) this.byOpId.delete(record.opId)
  }

  private record(id: ProcessId): ProcessRecord {
    const record = this.records.get(id)
    if (record === undefined) throw new Error('Unknown or expired workspace daemon process handle')
    return record
  }

  private async finishFailed(record: ProcessRecord, result: Promise<Completion>): Promise<void> {
    record.ordinary?.terminate()
    if (record.ordinary !== undefined) await record.ordinary.waitForExit()
    if (record.terminal !== undefined) await record.terminal.terminate()
    await this.rememberCompleted(record, result)
  }

  private async rememberCompleted(record: ProcessRecord, result: Promise<Completion>): Promise<void> {
    const id = record.id
    if (this.records.get(id) !== record) return
    this.records.delete(id)
    this.completed.set(id, {
      done: result,
      startResult: record.startResult ?? {},
      ...(record.startResult === undefined ? { startFailure: startFailure(record) } : {}),
      opId: record.opId,
    })
    await Promise.all(Object.values(record.endpoints).map(endpoint => endpoint.close()))
  }
}
