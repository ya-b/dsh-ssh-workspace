/**
 * Client transport for one remote workspace host: a shape-compatible
 * `SshConnection` whose request/stream surface the official
 * `SshFileSystem` / `SshSubprocessRuntime` / `SshSandboxProvider` consume
 * unchanged, but whose backend is the remote workspace daemon reached through
 * SSH as a data pipe. SSH outages therefore never interrupt remote execution:
 * the transport reconnects with backoff, re-attaches streams by byte offset,
 * and re-issues only operations the daemon can deduplicate (opId) or that
 * converge (idempotent mutations).
 * @module @dsh-ssh-workspace/transport
 */

import { randomUUID } from 'node:crypto'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { connect, type TLSSocket } from 'node:tls'
import { createConnection, type Socket } from 'node:net'
import { Duplex } from 'node:stream'
import { basename, join } from 'node:path'
import { RpcPeer, RemoteOperationError, RpcTransportError } from '@dsh-ssh-workspace/rpc'
import { z } from 'zod'

/** Stream endpoint coordinates published by the daemon. */
export interface StreamEndpoint {
  path: string
  capability: string
}

/** Reconnection state of one workspace transport. */
export type TransportStatus = 'connecting' | 'ready' | 'reconnecting' | 'closed'

/** Deployment configuration for one remote workspace connection. */
export interface RemoteWorkspaceConfig {
  /** OpenSSH host alias. */
  readonly host: string
  /** Absolute remote workspace path. */
  readonly workspace: string
  /** Absolute remote daemon state directory. */
  readonly daemonDir: string
  /** Absolute remote Node executable. */
  readonly node: string
  /** Per-request administrative deadline. */
  readonly requestTimeoutMs?: number
  /** Maximum JSON frame bytes. */
  readonly maxFrameBytes?: number
  /** Maximum ordinary pending requests. */
  readonly maxPending?: number
  /** Reconnect backoff base in milliseconds. */
  readonly reconnectBaseMs?: number
  /** Reconnect backoff ceiling in milliseconds. */
  readonly reconnectMaxMs?: number
  /** Local control directory; a temp directory when absent. */
  readonly controlDir?: string
}

/** Attempts one never-established session makes before its caller hears the failure. */
const INITIAL_CONNECT_ATTEMPTS = 6

const PSK_TLS = {
  ciphers: 'PSK-AES256-GCM-SHA384', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
} as const

const allowResultSchema = z.object({ roots: z.array(z.string()) }).strict()

const helloSchema = z.object({
  protocol: z.literal(1), platform: z.enum(['linux', 'darwin']), nodeVersion: z.string(),
  executable: z.string(), root: z.string(), workspace: z.string(), instanceId: z.string(), kind: z.string(),
}).strict()

/** Remote daemon handshake facts. */
export type DaemonHello = z.infer<typeof helloSchema>

/** Operations whose failure the transport may retry without any dedupe key. */
const REISSUABLE = new Set([
  'hello', 'heartbeat', 'session.reattach',
  'fs.resolve', 'fs.stat', 'fs.lstat', 'fs.list', 'fs.readText', 'fs.next', 'fs.readBytes', 'fs.readRange',
  'process.done', 'process.wait', 'process.terminate',
  'terminal.environment', 'terminal.inspect', 'terminal.activity', 'terminal.signal', 'terminal.resize',
  'executable', 'sandbox',
])

/** Operations that carry a transport-injected opId so a retry stays idempotent. */
const OPID_METHODS = new Set(['fs.write', 'fs.edit', 'process.prepare', 'process.start', 'terminal.write'])

/** Replay-bearing channels: those whose sockets precede data with a `{sync}` frame. */
const REPLAY_CHANNELS = new Set(['stdout', 'stderr', 'terminal'])

/** Quote one token for a POSIX remote shell. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

const BRIDGE = [
  "const net=require('node:net');",
  'const s=net.createConnection(process.argv[1]);',
  "s.on('connect',()=>{process.stdin.pipe(s);s.pipe(process.stdout)});",
  "s.on('error',e=>{console.error('workspace daemon bridge: '+e.message);process.exit(1)});",
  "const end=()=>{s.end();setTimeout(()=>process.exit(0),200)};",
  "s.on('close',end);process.stdin.on('end',end);process.stdin.on('error',end);",
].join('')

/**
 * Remote shell expression for a daemon state directory. A leading `~/` must
 * expand on the remote side, so it becomes `"$HOME/..."`; any other spelling is
 * single-quoted literally, which keeps command substitution out of reach.
 * @param directory - configured daemon state directory.
 * @returns a shell-safe expression evaluating to the directory.
 */
export function daemonDirExpr(directory: string): string {
  if (directory === '~') return '"$HOME"'
  if (directory.startsWith('~/') && /^[A-Za-z0-9._/-]+$/.test(directory.slice(2))) {
    return `"$HOME/${directory.slice(2)}"`
  }
  return shellQuote(directory)
}

/** Remote command: ensure the daemon runs on its state directory and bridge stdio to it. */
export function bootstrapCommand(config: RemoteWorkspaceConfig): string {
  const dir = daemonDirExpr(config.daemonDir)
  const node = shellQuote(config.node)
  return [
    `D=${dir}`,
    'mkdir -p "$D"',
    // A socket without a live owner is the crash residue of a daemon that was
    // killed outright: clear it, or the boot below would wait on a listener
    // that no longer exists.
    'if [ -S "$D/sock" ] && { [ ! -f "$D/pid" ] || ! kill -0 "$(cat "$D/pid" 2>/dev/null)" 2>/dev/null; }; then rm -f "$D/sock" "$D/pid" "$D/lock"; fi',
    // Preflight the interpreter so a missing or ancient remote Node names the
    // requirement instead of surfacing as "the socket never appeared".
    `${node} -e ${shellQuote(NODE_PREFLIGHT)} || { echo "remote workspace daemon preflight failed: ${node} is not a usable Node >= 20" >&2; exit 1; }`,
    `if [ ! -S "$D/sock" ]; then setsid nohup ${node} "$D/workspaced.js" --dir "$D" >>"$D/daemon.log" 2>&1 </dev/null & sleep 0.2; fi`,
    'i=0; while [ ! -S "$D/sock" ] && [ $i -lt 100 ]; do i=$((i+1)); sleep 0.1; done',
    '[ -S "$D/sock" ] || { echo "workspace daemon socket did not appear" >&2; exit 1; }',
    `exec ${node} -e ${shellQuote(BRIDGE)} "$D/sock"`,
  ].join('; ')
}

/** Remote preflight: the daemon needs a Node that can run its single-file bundle. */
const NODE_PREFLIGHT = [
  'const major = Number(process.versions.node.split(".")[0])',
  'if (!Number.isFinite(major) || major < 20) {',
  '  console.error("dsh workspace daemon requires Node >= 20 on the remote host (found " + process.version + " at " + process.execPath + "); install Node 20+ or point the daemon node setting at it")',
  '  process.exit(1)',
  '}',
].join('; ')

/** Remote command: atomically install the daemon bundle from this channel's stdin. */
export function installCommand(config: RemoteWorkspaceConfig): string {
  return [
    `D=${daemonDirExpr(config.daemonDir)}`,
    'mkdir -p "$D"',
    'cat > "$D/workspaced.js.tmp" && mv "$D/workspaced.js.tmp" "$D/workspaced.js"',
  ].join('; ')
}

/** Copy the daemon bundle to one remote host over a dedicated SSH channel. */
export async function installDaemon(config: RemoteWorkspaceConfig, bundle: Buffer, deadlineMs = 60_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile('ssh', [
      '-T', config.host, installCommand(config),
    ], { maxBuffer: 1024 * 1024, timeout: deadlineMs }, (error) => { if (error === null) resolve(); else reject(error) })
    child.stdin?.end(bundle)
    child.stderr?.on('error', () => {})
    child.stderr?.resume()
  })
}

/** One live SSH master carrying the daemon RPC channel. */
interface MasterSession {
  readonly process: ChildProcessWithoutNullStreams
  readonly peer: RpcPeer
  readonly hello: DaemonHello
  readonly controlPath: string
  readonly directory: string
  readonly closed: Promise<void>
  close(): Promise<void>
}

/**
 * A stream handle that survives reconnection. Consumers (the official
 * subprocess provider) call `pipe`, `write`, `end`, `destroy`, `once('close')`
 * and read `closed` — everything a `net.Socket` surface they rely on.
 */
class DurableStream extends Duplex {
  private socket: TLSSocket | undefined
  /** Acknowledged byte offset: everything handed to the consumer so far. */
  private acknowledged = 0
  private readonly endpoint: StreamEndpoint
  private readonly channel: string

  private readonly transport: RemoteWorkspaceTransport
  private readonly lifetime: AbortSignal

  constructor(transport: RemoteWorkspaceTransport, endpoint: StreamEndpoint, lifetime: AbortSignal) {
    super({ allowHalfOpen: true })
    this.transport = transport
    this.endpoint = endpoint
    this.lifetime = lifetime
    this.channel = basename(endpoint.path)
    // The provider attaches its own handlers; an unhandled 'error' would kill
    // the process. Transport-loss failures are recovered by re-attachment.
    this.on('error', () => {})
    void this.attach()
  }

  /** `net.Socket`-compatible liveness flag read by the official provider. */
  closed = false
  get ackOffset(): number { return this.acknowledged }

  /** Force a re-attach after the transport reconnected (dead sockets may never emit 'close'). */
  rebind(): void {
    if (this.closed || this.lifetime.aborted) return
    void this.attach()
  }

  private async attach(): Promise<void> {
    if (this.closed || this.lifetime.aborted) return
    try {
      const socket = await this.transport.attachStream(this.endpoint, this.channel, this.acknowledged, this.lifetime)
      if (this.closed) { socket.destroy(); return }
      this.socket?.destroy()
      this.socket = socket
      socket.on('data', (chunk: Buffer) => {
        this.acknowledged += chunk.length
        if (!this.push(chunk)) { socket.pause(); this.once('_readable_resume', () => { socket.resume() }) }
      })
      // A Duplex only pulls when read; the daemon-side flow starts pushing as
      // soon as the replay preamble is answered, so resume explicitly here.
      socket.resume()
      // Socket end means this attachment died, never the logical stream: the
      // consumer's end of stream is decided by process.done, not by SSH.
      socket.on('end', () => { if (!this.closed && !this.lifetime.aborted) void this.recover() })
      socket.on('error', () => { /* reconnect loop owns recovery */ })
      socket.on('close', () => {
        if (this.closed || this.lifetime.aborted) return
        void this.recover()
      })
      this.emit('attach')
    } catch {
      void this.recover()
    }
  }

  private async recover(): Promise<void> {
    if (this.closed || this.lifetime.aborted) return
    await this.transport.awaitReady().catch(() => {})
    void this.attach()
  }

  override _read(): void {
    this.emit('_readable_resume')
    this.socket?.resume()
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const socket = this.socket
    if (socket === undefined || socket.destroyed) {
      // Queue until the transport reconnects: stdin/control writes are durable.
      const wait = (): void => {
        if (this.closed) { callback(new Error('remote workspace stream closed before write')); return }
        const live = this.socket
        if (live !== undefined && !live.destroyed) { live.write(chunk, callback); return }
        setTimeout(wait, 25).unref()
      }
      wait()
      return
    }
    socket.write(chunk, callback)
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.socket?.end()
    callback()
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.closed = true
    this.socket?.destroy()
    this.socket = undefined
    this.emit('close')
    callback(error)
  }
}

/** Shape-compatible replacement for `SshConnection` whose backend is the daemon. */
export class RemoteWorkspaceTransport {
  private master: MasterSession | undefined
  private status: TransportStatus = 'connecting'
  private attempt = 0
  private stopped = false
  private sessionReady: Promise<MasterSession> | undefined
  private directory: string | undefined
  private nextStream = 0
  private readonly streams = new Set<DurableStream>()
  private readonly lifetime = new AbortController()
  private queue: Promise<unknown> = Promise.resolve()

  private readonly config: RemoteWorkspaceConfig

  constructor(config: RemoteWorkspaceConfig) { this.config = config }

  get state(): TransportStatus { return this.status }
  get hello(): DaemonHello | undefined { return this.master?.hello }

  /**
   * The daemon session identity this transport joins. Published so an operator
   * tool (or a test) can attach a second, independent channel to the *same*
   * session, which is how a probe inspects a live session without disturbing it.
   * @returns the session uuid, or undefined before the first connection attempt.
   */
  /**
   * Absolute local path of this session's SSH control socket. Published for the
   * same reason as {@link clientId}: an operator or test can inspect or end the
   * channel with `ssh -S <path> -O check|exit <host>`.
   * @returns the control socket path, or undefined before the first attempt.
   */
  get controlSocket(): string | undefined {
    return this.master?.controlPath ?? (this.directory === undefined ? undefined : join(this.directory, 'master'))
  }

  get clientId(): string | undefined {
    return this.directory === undefined ? undefined : this.clientUuid(this.directory)
  }
  /** Local control socket of the live SSH master (diagnostics and forced outage tests). */
  get controlPath(): string | undefined { return this.master?.controlPath }

  /** Establish the first session; resolves once the daemon handshake completes. */
  async open(): Promise<void> { await this.ensureSession() }

  /** Wait until a live session exists (used by stream re-attachment). */
  async awaitReady(): Promise<void> { await this.ensureSession() }

  /** Release local resources; the remote daemon keeps executing. */
  async dispose(): Promise<void> {
    this.stopped = true
    this.status = 'closed'
    this.lifetime.abort(new Error('remote workspace transport disposed'))
    for (const stream of [...this.streams]) stream.destroy()
    this.streams.clear()
    const master = this.master
    this.master = undefined
    if (master !== undefined) await master.close()
    // The control directory is scratch space: a leftover file (an SSH master
    // still settling) must never turn disposal into a failure the caller sees.
    if (this.directory !== undefined) {
      await rm(this.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {})
    }
  }

  /**
   * Send one daemon operation, transparently surviving transport loss.
   * @param method - daemon operation name (official provider call sites).
   * @param params - request fields.
   * @param result - response validation.
   * @param signal - caller cancellation.
   * @param wait - allow the observation to outlast the administrative deadline.
   */
  async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait = false): Promise<T> {
    const bounded = wait ? signal : signal === undefined
      ? AbortSignal.timeout(this.config.requestTimeoutMs ?? 30_000)
      : AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs ?? 30_000)])
    const opId = OPID_METHODS.has(method) ? randomUUID().replaceAll('-', '') : undefined
    const body = opId === undefined ? params : { ...(params as Record<string, unknown>), opId }
    for (;;) {
      bounded?.throwIfAborted()
      const session = await this.ensureSession()
      try {
        return await session.peer.request(method, body, result, bounded ?? undefined)
      } catch (error) {
        bounded?.throwIfAborted()
        if (this.stopped) throw error
        // Only a genuine transport loss is retryable. A remote operation
        // error, a response-schema error, or a caller abort must surface
        // unchanged: silently re-issuing those would hide real failures
        // (and, worse, churn SSH connections in a loop).
        if (!this.isTransportLoss(error)) throw error
        if (!(REISSUABLE.has(method) || opId !== undefined)) throw error
        // Transport loss: reconnect and re-issue. The daemon's opId gate (for
        // mutations) or read-only nature (for observations) makes this safe.
        await this.reconnect()
      }
    }
  }

  /**
   * Open one authenticated stream to a daemon endpoint. The returned handle
   * re-attaches automatically after a transport outage, resuming at the byte
   * offset already delivered to its consumer.
   */
  async connectStream(endpoint: StreamEndpoint, signal?: AbortSignal): Promise<Duplex> {
    const hello = await this.ensureSession().then(session => session.hello)
    const remote = endpoint.path
    if (!remote.startsWith(`${hello.root}/`) || /[:\r\n\0]/u.test(remote)) throw new Error('workspace daemon returned an invalid stream path')
    signal?.throwIfAborted()
    const stream = new DurableStream(this, endpoint, AbortSignal.any([this.lifetime.signal, ...(signal === undefined ? [] : [signal])]))
    this.streams.add(stream)
    stream.once('close', () => { this.streams.delete(stream) })
    return stream
  }

  /** Attach one TLS-PSK socket to a forwarded endpoint, replaying from `offset`. */
  async attachStream(endpoint: StreamEndpoint, channel: string, offset: number, lifetime: AbortSignal): Promise<TLSSocket> {
    const session = await this.ensureSession()
    const local = join(this.directory as string, `s${this.nextStream++}`)
    await this.control(session, ['-O', 'forward', '-o', 'ExitOnForwardFailure=yes', '-L', `${local}:${endpoint.path}`])
    lifetime.throwIfAborted()
    const raw = createConnection({ path: local, allowHalfOpen: true })
    raw.on('error', () => {})
    await new Promise<void>((resolve, reject) => {
      const connected = (): void => { cleanup(); resolve() }
      const failed = (error: Error): void => { cleanup(); reject(error) }
      const aborted = (): void => { raw.destroy(lifetime.reason as Error); failed(new Error('stream attach aborted')) }
      const cleanup = (): void => {
        raw.off('connect', connected)
        raw.off('error', failed)
        lifetime.removeEventListener('abort', aborted)
      }
      raw.once('connect', connected)
      raw.once('error', failed)
      lifetime.addEventListener('abort', aborted, { once: true })
    })
    const tls = connect({
      ...PSK_TLS, socket: raw, rejectUnauthorized: true, checkServerIdentity: () => undefined,
      pskCallback: () => ({ psk: Buffer.from(endpoint.capability, 'hex'), identity: 'dsh-stream' }),
    })
    tls.on('error', () => {})
    await new Promise<void>((resolve, reject) => {
      const secured = (): void => { cleanup(); resolve() }
      const failed = (error: Error): void => { cleanup(); reject(error) }
      const closed = (): void => { failed(new Error('workspace daemon stream closed during authentication')) }
      const aborted = (): void => { tls.destroy(lifetime.reason as Error) }
      const cleanup = (): void => {
        tls.off('secureConnect', secured)
        tls.off('error', failed)
        tls.off('close', closed)
        lifetime.removeEventListener('abort', aborted)
      }
      tls.once('secureConnect', secured)
      tls.once('error', failed)
      tls.once('close', closed)
      lifetime.addEventListener('abort', aborted, { once: true })
    })
    tls.disableRenegotiation()
    if (REPLAY_CHANNELS.has(channel)) {
      const body = Buffer.from(JSON.stringify({ sync: offset }))
      const header = Buffer.alloc(4)
      header.writeUInt32BE(body.length)
      tls.write(Buffer.concat([header, body]))
    }
    tls.pause()
    return tls
  }

  private isTransportLoss(error: unknown): boolean {
    if (error instanceof RemoteOperationError) return false
    if (error instanceof RpcTransportError) return true
    if (this.master === undefined) return true
    // Node socket/ssh exec failures carry no typed marker; treat only their
    // well-known shapes as loss.
    const code = (error as { code?: unknown } | null)?.code
    return typeof code === 'string' && ['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED'].includes(code)
  }

  private control(session: MasterSession, args: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = execFile('ssh', ['-S', session.controlPath, ...args, this.config.host], {
        signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? 30_000), maxBuffer: 64 * 1024,
      }, (error) => { if (error === null) resolve(); else reject(error) })
      child.stderr?.resume()
    })
  }

  private ensureSession(): Promise<MasterSession> {
    if (this.stopped) return Promise.reject(new Error('remote workspace transport is closed'))
    const live = this.master
    if (live !== undefined && this.status === 'ready') return Promise.resolve(live)
    this.sessionReady ??= this.connectLoop()
    return this.sessionReady.finally(() => { this.sessionReady = undefined })
  }

  private async reconnect(): Promise<void> {
    const stale = this.master
    this.master = undefined
    if (stale !== undefined) await stale.close().catch(() => {})
    this.status = 'reconnecting'
    this.queue = this.queue.then(() => {}, () => {})
    await this.ensureSession()
  }

  private async connectLoop(): Promise<MasterSession> {
    const base = this.config.reconnectBaseMs ?? 250
    const ceiling = this.config.reconnectMaxMs ?? 15_000
    const established = this.master !== undefined
    let attempt = this.attempt
    for (;;) {
      if (this.stopped) throw new Error('remote workspace transport is closed')
      this.status = attempt === 0 ? 'connecting' : 'reconnecting'
      try {
        const session = await this.openOnce()
        this.master = session
        this.status = 'ready'
        this.attempt = 0
        // Dead forwarded sockets may never emit 'close': a reconnected
        // transport explicitly re-binds every live stream to its new SSH
        // channel, resuming each one at its consumer-acknowledged offset.
        for (const stream of [...this.streams]) stream.rebind()
        return session
      } catch (error) {
        attempt += 1
        this.attempt = attempt
        // A refusal (unknown host, denied workspace, protocol mismatch) is not
        // a transient loss: retrying it would loop forever and hide the reason
        // from whoever asked. Only a lost transport is worth more attempts.
        if (!this.isTransportLoss(error)) throw error
        // A session that lost its transport must keep trying forever — its
        // remote work is still running. A session that was never established
        // gives up, so a user-initiated call fails with the real reason.
        if (!established && attempt >= INITIAL_CONNECT_ATTEMPTS) throw error
        await new Promise<void>((resolve) => { setTimeout(resolve, Math.min(ceiling, base * 2 ** Math.min(attempt, 6))).unref() })
      }
    }
  }

  private async openOnce(): Promise<MasterSession> {
    this.directory ??= this.config.controlDir ?? await mkdtemp('/tmp/dsh-ws-')
    const directory = this.directory
    const controlPath = join(directory, 'master')
    const child = spawn('ssh', [
      '-T', '-M', '-S', controlPath, '-o', 'ControlPersist=no',
      '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
      this.config.host, bootstrapCommand(this.config),
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    const closed = Promise.withResolvers<void>()
    child.once('close', () => { closed.resolve() })
    child.once('error', () => { closed.resolve() })
    child.stderr.on('error', () => {})
    child.stderr.resume()
    const peer = new RpcPeer(child.stdout, child.stdin, this.config.maxFrameBytes ?? 64 * 1024 * 1024, this.config.maxPending ?? 128)
    const deadline = this.config.requestTimeoutMs ?? 30_000
    // Declare the workspace before asking to join it: an older daemon answers
    // this with an error frame, which is exactly the "no such method" case and
    // is ignored. A newer one extends its whitelist and persists it.
    if (this.config.workspace !== '') {
      await peer.request('workspace.allow', { path: this.config.workspace }, allowResultSchema, AbortSignal.timeout(deadline))
        .catch(() => undefined)
    }
    const hello = await peer.request('hello', {
      protocol: 1, workspace: this.config.workspace, clientUuid: this.clientUuid(directory),
    }, helloSchema, AbortSignal.timeout(deadline)).catch((error: unknown) => {
      // The session is unusable: release the SSH channel instead of leaving a
      // master and its bridge behind for every failed attempt.
      child.kill('SIGKILL')
      peer.close(error instanceof Error ? error : new Error(String(error)))
      throw error
    })
    peer.once('closed', () => {
      // Transport loss only marks the session stale; the daemon keeps running.
      if (this.master?.peer === peer) { this.master = undefined; this.status = 'reconnecting' }
    })
    return {
      process: child, peer, hello, controlPath, directory,
      closed: closed.promise,
      async close(): Promise<void> {
        peer.close()
        try { child.kill('SIGTERM') } catch { /* already exited */ }
        await closed.promise.catch(() => {})
      },
    }
  }

  private clientUuid(directory: string): string {
    this.cachedUuid ??= (() => {
      let hash = 0x811c9dc5
      for (const char of `${directory}\u0000${this.config.host}\u0000${this.config.workspace}`) {
        hash ^= char.codePointAt(0) ?? 0
        hash = Math.imul(hash, 0x01000193)
      }
      return `client-${(hash >>> 0).toString(16).padStart(8, '0')}${(process.pid % 0xffff).toString(16).padStart(4, '0')}`
    })()
    return this.cachedUuid
  }

  private cachedUuid: string | undefined
}

export { RemoteOperationError }
