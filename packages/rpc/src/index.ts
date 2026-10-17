/**
 * Bounded, length-prefixed JSON request/C responders shared by the workspace
 * daemon (server side) and its client transport (client side). Framing and
 * pending management mirror the vocabulary of the official SSH helper peer so
 * provider packages keep their call-site semantics, while the implementation
 * is this workspace's own: identical on both ends, no versioned drift.
 * @module @dsh-ssh-workspace/rpc
 */

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { z } from 'zod'

const errorSchema = z.object({ name: z.string(), message: z.string(), code: z.string().optional() }).strict()
const requestIdSchema = z.string()
const frameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('request'), id: requestIdSchema, method: z.string(), params: z.unknown() }).strict(),
  z.object({ type: z.literal('result'), id: requestIdSchema, value: z.unknown() }).strict(),
  z.object({ type: z.literal('error'), id: requestIdSchema, error: errorSchema }).strict(),
  z.object({ type: z.literal('cancel'), id: requestIdSchema }).strict(),
])
type Frame = z.infer<typeof frameSchema>

function operationError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** The peer's transport is gone; the operation's remote outcome is unknown and a retry is the caller's decision. */
export class RpcTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RpcTransportError'
  }
}

/** Remote error retaining its typed filesystem or sandbox code. */
export class RemoteOperationError extends Error {
  readonly code: string | undefined
  constructor(message: string, code?: string) {
    super(message)
    this.name = 'RemoteOperationError'
    this.code = code
  }
}

const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024

/**
 * One RPC peer over a length-prefixed JSON stream. Callers `request()` with a
 * zod schema; receivers register a handler and may emit `cancel` frames.
 * Connection loss rejects every pending call and aborts active handlers
 * without claiming rollback.
 */
export class RpcPeer extends EventEmitter {
  private readonly pending = new Map<string, {
    resolve(value: unknown): void
    reject(error: Error): void
    management: boolean
  }>()
  private readonly active = new Map<string, { controller: AbortController; management: boolean }>()
  private readonly input: Readable
  private readonly output: Writable
  private readonly maxFrameBytes: number
  private readonly maxPending: number
  private readonly handler: ((method: string, params: unknown, signal: AbortSignal) => Promise<unknown>) | undefined
  private writeTail = Promise.resolve()
  private queuedBytes = 0
  private failure: Error | undefined

  constructor(
    input: Readable,
    output: Writable,
    maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES,
    maxPending: number = 128,
    handler?: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>,
  ) {
    super()
    this.input = input
    this.output = output
    this.maxFrameBytes = maxFrameBytes
    this.maxPending = maxPending
    this.handler = handler
    input.on('error', (error) => { this.close(error) })
    output.on('error', (error) => { this.close(error) })
    output.on('close', () => { this.close() })
    void this.readFrames().catch((error: unknown) => { this.close(operationError(error)) })
  }

  /** Send one request and validate its response. */
  async request<T>(method: string, params: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    if (this.failure !== undefined) throw this.failure
    if (this.pending.size >= this.maxPending) throw new Error('RPC pending request limit reached')
    const id = randomUUID()
    const result = Promise.withResolvers<unknown>()
    void result.promise.catch(() => {})
    this.pending.set(id, { ...result, management: false })
    const abort = (): void => {
      result.reject(signal!.reason instanceof Error ? signal!.reason : new Error('RPC operation cancelled'))
      void this.send({ type: 'cancel', id }).catch(() => {})
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      void this.send({ type: 'request', id, method, params }).catch((error: unknown) => {
        this.pending.delete(id)
        result.reject(operationError(error))
      })
      return schema.parse(await result.promise)
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  /** Raw request without schema validation, for the transport's own control plane. */
  async requestRaw(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    return await this.request(method, params, z.unknown(), signal)
  }

  /** Fail pending operations and abort active handlers. */
  close(error: Error = new RpcTransportError('RPC connection lost; remote operation outcome is unknown')): void {
    if (this.failure !== undefined) return
    this.failure = error
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const { controller } of this.active.values()) controller.abort(error)
    this.active.clear()
    this.input.destroy()
    this.output.destroy()
    this.emit('closed', error)
  }

  get closedError(): Error | undefined { return this.failure }

  private async send(frame: Frame): Promise<void> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    const body = Buffer.from(JSON.stringify(frame))
    if (body.length > this.maxFrameBytes || this.queuedBytes + body.length + 4 > this.maxFrameBytes * 2) {
      return Promise.reject(new Error('RPC frame or write queue limit exceeded'))
    }
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.length)
    const bytes = Buffer.concat([header, body])
    this.queuedBytes += bytes.length
    const write = this.writeTail.then(async () => {
      if (this.failure !== undefined) throw this.failure
      if (!this.output.write(bytes)) await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => { this.output.off('drain', drained); this.off('closed', closed) }
        const drained = (): void => { cleanup(); resolve() }
        const closed = (error: Error): void => { cleanup(); reject(error) }
        this.output.once('drain', drained)
        this.once('closed', closed)
        if (this.failure !== undefined) closed(this.failure)
      })
    })
    this.writeTail = write.catch((error: unknown) => { this.close(operationError(error)) })
    return write.finally(() => { this.queuedBytes -= bytes.length })
  }

  private async readFrames(): Promise<void> {
    const header = Buffer.alloc(4)
    let headerBytes = 0
    let payload: Buffer | undefined
    let payloadBytes = 0
    for await (const raw of this.input) {
      const chunk: Buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array)
      let offset = 0
      while (offset < chunk.length) {
        if (payload === undefined) {
          const count = Math.min(4 - headerBytes, chunk.length - offset)
          chunk.copy(header, headerBytes, offset, offset + count)
          headerBytes += count
          offset += count
          if (headerBytes < 4) continue
          const size = header.readUInt32BE(0)
          if (size === 0 || size > this.maxFrameBytes) throw new Error('RPC peer sent an invalid frame length')
          payload = Buffer.alloc(size)
          payloadBytes = 0
        }
        const count = Math.min(payload.length - payloadBytes, chunk.length - offset)
        chunk.copy(payload, payloadBytes, offset, offset + count)
        payloadBytes += count
        offset += count
        if (payloadBytes === payload.length) {
          const frame = frameSchema.parse(JSON.parse(payload.toString('utf8')))
          payload = undefined
          headerBytes = 0
          this.receive(frame)
        }
      }
    }
    throw new RpcTransportError(headerBytes > 0 || payload !== undefined ? 'RPC peer disconnected during a frame; outcome is unknown' : 'RPC peer disconnected; outcome is unknown')
  }

  private receive(frame: Frame): void {
    if (frame.type === 'result' || frame.type === 'error') {
      const pending = this.pending.get(frame.id)
      if (pending === undefined) return
      this.pending.delete(frame.id)
      if (frame.type === 'result') pending.resolve(frame.value)
      else pending.reject(new RemoteOperationError(frame.error.message, frame.error.code))
      return
    }
    if (frame.type === 'cancel') {
      this.active.get(frame.id)?.controller.abort(new Error('RPC caller cancelled the operation'))
      return
    }
    if (this.handler === undefined || this.active.has(frame.id) || this.pending.size + this.active.size >= this.maxPending * 2) {
      throw new Error('RPC peer received an unexpected or excessive request')
    }
    const controller = new AbortController()
    this.active.set(frame.id, { controller, management: false })
    void this.handler(frame.method, frame.params, controller.signal).then(
      value => this.send({ type: 'result', id: frame.id, value: value ?? null }),
      (error: unknown) => {
        const detail = operationError(error)
        const code = 'code' in detail && typeof detail.code === 'string' ? detail.code : undefined
        return this.send({ type: 'error', id: frame.id, error: {
          name: detail.name, message: detail.message, ...(code === undefined ? {} : { code }),
        } })
      },
    ).catch((error: unknown) => { this.close(operationError(error)) })
      .finally(() => { this.active.delete(frame.id) })
  }
}
