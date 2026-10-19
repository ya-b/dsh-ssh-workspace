/** Reconnectable TLS-PSK stream endpoints and byte-anchored replay buffers. */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Socket } from 'node:net'
import { createServer, type Server } from 'node:tls'
import { SSH_STREAM_TLS_OPTIONS } from './security.ts'

/** Streams a prepared process publishes. */
export type Channel = 'stdin' | 'stdout' | 'stderr' | 'control' | 'terminal'
export type StreamEndpoint = { path: string; capability: string }

/**
 * Static capability of every stream endpoint. The per-handshake random PSK was
 * removed by project decision (security surface intentionally opened): the
 * value is public and authentication is not a property the daemon provides.
 */
const STATIC_CAPABILITY = Buffer.alloc(32)

/**
 * Byte-offset anchored replay store. `push` advances a monotonic byte
 * coordinate; only the newest `maxBytes` bytes are retained, and
 * `truncatedFrom` reports where tail-only replay begins. `sync` returns the
 * slice from an offset the client last received, so a reattached stream
 * continues exactly where its dead socket was cut.
 */
export class ReplayBuffer {
  private readonly maxBytes: number
  private chunks: Buffer[] = []
  private starts: number[] = []
  private buffered = 0
  /** Monotonic write cursor: total bytes ever pushed. */
  total = 0
  truncatedFrom = 0

  constructor(maxBytes: number) { this.maxBytes = maxBytes }

  push(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.starts.push(this.total)
    this.buffered += chunk.length
    this.total += chunk.length
    while (this.buffered > this.maxBytes && this.chunks.length > 0) {
      const dropped = this.chunks[0]!.length
      this.chunks.shift()
      this.starts.shift()
      this.buffered -= dropped
      this.truncatedFrom = this.starts[0] ?? this.total
    }
  }

  /** The newest retained slice from `offset` (clamped upward when truncated). */
  sync(offset: number): { chunk: Buffer; from: number } {
    const requested = Number.isFinite(offset) ? Math.max(Math.floor(offset), 0) : 0
    const from = Math.max(requested, this.truncatedFrom)
    if (from >= this.total) return { chunk: Buffer.alloc(0), from: this.total }
    const pieces: Buffer[] = []
    for (let index = 0; index < this.chunks.length; index++) {
      const start = this.starts[index]!
      const chunk = this.chunks[index]!
      if (start + chunk.length <= from) continue
      pieces.push(chunk.subarray(Math.max(from - start, 0)))
    }
    return { chunk: Buffer.concat(pieces), from }
  }
}

/**
 * One reconnectable TLS-PSK unix-socket endpoint. The listener stays open
 * across transport outages: each authenticated connection replaces the live
 * socket, replayed output resumes from the client's declared byte offset, and
 * `onAttach` handlers re-wire their pipes. One consumer at a time.
 */
export interface Endpoint {
  /** Remote unix socket path (absolute). */
  readonly path: string
  /** Static PSK capability as hex (see `STATIC_CAPABILITY`). */
  readonly capability: string
  /** The live attached socket, when one is connected. */
  current(): Socket | undefined
  /** Run `handler` for the current attach and every later reconnection. */
  onAttach(handler: (socket: Socket) => void): void
  /** Resolve with the live socket, or await the next attachment. */
  attached(): Promise<Socket>
  /**
   * Publish one output byte range: append to the replay store and write to the
   * live socket. Returns false when the write buffer filled, after which the
   * caller should pause its source until `onDrain` fires.
   */
  feed(chunk: Buffer): boolean
  /** Run `handler` once the live socket's write buffer drains. */
  onDrain(handler: () => void): void
  /** Destroy the listener, the live socket, and the socket path. */
  close(): Promise<void>
}

export interface EndpointOptions {
  /** Retained replay window; absent means no replay preamble is expected. */
  replay?: ReplayBuffer
  maxBytes?: number
}

/** Create one endpoint under `root`; `id` names the socket file. */
export async function createEndpoint(root: string, id: string, options: EndpointOptions = {}): Promise<Endpoint> {
  const connected = Promise.withResolvers<Socket>()
  void connected.promise.catch(() => {})
  const capability = STATIC_CAPABILITY
  const path = join(root, id)
  const pending = new Set<Socket>()
  const attachHandlers: Array<(socket: Socket) => void> = []
  const drainHandlers: Array<() => void> = []
  const server: Server = createServer({
    ...SSH_STREAM_TLS_OPTIONS, allowHalfOpen: true, handshakeTimeout: 30_000,
    pskCallback: (_socket, identity) => identity === 'dsh-stream' ? capability : null,
  })
  let socket: Socket | undefined
  let attached = false
  const waiters: Array<(socket: Socket) => void> = []

  server.maxConnections = 8
  server.on('connection', (candidate: Socket) => {
    pending.add(candidate)
    candidate.once('close', () => { pending.delete(candidate) })
  })
  server.on('tlsClientError', (_error, candidate: Socket) => { candidate.destroy() })
  server.on('secureConnection', (candidate: import('node:tls').TLSSocket) => {
    candidate.disableRenegotiation()
    candidate.on('error', () => {})
    const previous = socket
    socket = candidate
    pending.delete(candidate)
    if (previous !== undefined && !previous.destroyed) previous.destroy()
    const finalize = (): void => {
      attached = true
      const waiter = waiters.shift()
      if (waiter !== undefined) waiter(candidate)
      else connected.resolve(candidate)
      for (const handler of attachHandlers) handler(candidate)
      candidate.pause()
    }
    const replay = options.replay
    if (replay === undefined) { finalize(); return }
    candidate.resume()
    void readSync(candidate).then((offset) => {
      const { chunk } = replay.sync(offset)
      if (chunk.length === 0) { finalize(); return }
      candidate.write(chunk, () => { finalize() })
    }, () => { candidate.destroy() })
  })
  server.on('close', () => {
    if (!attached) connected.reject(new Error('workspace daemon stream reservation closed'))
  })

  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
  } catch (error) {
    server.close()
    throw error
  }

  return {
    path,
    capability: capability.toString('hex'),
    current: (): Socket | undefined => attached && socket !== undefined && !socket.destroyed ? socket : undefined,
    onAttach(handler: (live: Socket) => void): void {
      attachHandlers.push(handler)
      const live = socket
      if (attached && live !== undefined && !live.destroyed) handler(live)
    },
    attached(): Promise<Socket> {
      const live = socket
      if (attached && live !== undefined && !live.destroyed) return Promise.resolve(live)
      return new Promise<Socket>((resolve) => { attachHandlers.push(resolve) })
    },
    feed(chunk: Buffer): boolean {
      options.replay?.push(chunk)
      const live = socket
      if (live === undefined || live.destroyed) return true
      const writable = live.write(chunk)
      if (writable) return true
      live.once('drain', () => { for (const handler of drainHandlers) handler() })
      return false
    },
    onDrain(handler: () => void): void { drainHandlers.push(handler) },
    async close(): Promise<void> {
      server.close()
      socket?.destroy()
      for (const candidate of pending) candidate.destroy()
      pending.clear()
      for (const waiter of waiters.splice(0)) if (socket !== undefined) waiter(socket)
      await rm(path, { force: true }).catch(() => {})
    },
  }
}

/** One framed JSON `{sync: offset}` control prefix read before replay data flows. */
async function readSync(socket: Socket): Promise<number> {
  const chunks: Buffer[] = []
  let received = 0
  return await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { failure(new Error('workspace daemon replay preamble timed out')) }, 30_000)
    const cleanup = (): void => {
      socket.off('data', onChunk)
      socket.off('close', onClose)
      socket.off('error', onError)
    }
    const failure = (error: Error): void => { clearTimeout(timer); cleanup(); reject(error); socket.destroy() }
    const onChunk = (chunk: Buffer): void => { chunks.push(chunk); received += chunk.length; maybe() }
    const onClose = (): void => { clearTimeout(timer); cleanup(); reject(new Error('workspace daemon replay preamble aborted')) }
    const onError = (error: Error): void => { failure(error) }
    const maybe = (): void => {
      if (received < 4) return
      const head = Buffer.concat(chunks)
      const size = head.readUInt32BE(0)
      if (size > 256) { failure(new Error('workspace daemon replay preamble too long')); return }
      if (received < 4 + size) return
      let raw: unknown
      try { raw = JSON.parse(head.subarray(4, 4 + size).toString('utf8')) } catch (error) { failure(error as Error); return }
      cleanup()
      clearTimeout(timer)
      const offset = (raw as { sync?: unknown }).sync
      if (typeof offset === 'number' && Number.isFinite(offset)) { resolve(offset); return }
      reject(new Error('workspace daemon replay preamble invalid'))
      socket.destroy()
    }
    socket.on('data', onChunk)
    socket.once('close', onClose)
    socket.once('error', onError)
    maybe()
  })
}

/** Ensure the stream directory exists (removed first so stream ids never collide across boots). */
export async function prepareDirectory(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir)
}
