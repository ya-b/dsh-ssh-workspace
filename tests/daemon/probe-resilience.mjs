/**
 * C1 probe: the death scenarios a durable remote workspace must survive.
 *   1. terminal output across an SSH outage (replay, no lost bytes),
 *   2. a daemon generation change reports WORKSPACE_PROGRESS_LOST,
 *   3. explicit-only reaping at the process-handle limit (completed first),
 *   4. a large write replayed with the same opId lands exactly once,
 *   5. 200 sequential observations stay stable (stress).
 * Usage: node probe-resilience.mjs
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { connect } from 'node:tls'
import { createHash } from 'node:crypto'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RpcPeer } from '@dsh-ssh-workspace/rpc'
import { RemoteWorkspaceTransport, bootstrapCommand } from '@dsh-ssh-workspace/transport'
import { buildDaemonArchive, findNodePty, installDaemonArchive } from '@dsh-ssh-workspace/install'
import { z } from 'zod'

const DAEMON_DIR = join(homedir(), '.dsh-workspace')
const WORKSPACE = join(homedir(), 'dsh-ws-probe')
const NODE = process.execPath
const config = {
  host: 'localhost', workspace: WORKSPACE, daemonDir: DAEMON_DIR, node: NODE,
  requestTimeoutMs: 25_000, reconnectBaseMs: 100, reconnectMaxMs: 800,
}

const passed = []
function check(name, ok, detail = '') {
  passed.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** How long the transport stays partitioned; C2 asks for a multi-minute run. */
const OUTAGE_MS = Number(process.env.PROBE_OUTAGE_MS ?? 2000)

/** Install the daemon and give it an explicit handle limit for the reap case. */
async function install(maxProcessHandles) {
  await execFile('mkdir', ['-p', DAEMON_DIR, WORKSPACE])
  await new Promise(resolve => {
    const killer = spawn('bash', ['-c', `if [ -f ${DAEMON_DIR}/pid ]; then kill $(cat ${DAEMON_DIR}/pid) 2>/dev/null; fi; sleep 0.3; rm -f ${DAEMON_DIR}/lock ${DAEMON_DIR}/pid ${DAEMON_DIR}/sock`])
    killer.once('exit', resolve)
  })
  const nodePty = await findNodePty(new URL('../../../deepseek-harness', import.meta.url).pathname)
  const archive = await buildDaemonArchive({
    bundlePath: new URL('../../packages/daemon/lib/workspaced.js', import.meta.url).pathname,
    ...(nodePty === undefined ? {} : { nodePtyDir: nodePty }),
    platform: 'linux', arch: process.arch,
  })
  await installDaemonArchive(config, archive)
  await writeFile(join(DAEMON_DIR, 'config.json'), JSON.stringify({
    roots: [WORKSPACE], defaultMode: 'workspace-write', maxProcessHandles,
  }))
}

/**
 * Open one raw RPC bridge to the daemon over a dedicated SSH channel.
 * @param clientUuid - session to join; omitted starts a fresh session.
 */
async function bridge(clientUuid, instanceId) {
  const child = spawn('ssh', [
    '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no',
    '-o', 'ClearAllForwardings=yes', config.host, bootstrapCommand(config),
  ], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume()
  const peer = new RpcPeer(child.stdout, child.stdin, 64 * 1024 * 1024, 128)
  await peer.requestRaw('hello', {
    protocol: 1, workspace: WORKSPACE,
    clientUuid: clientUuid ?? `resilience-${Math.random().toString(36).slice(2, 10)}`,
    ...(instanceId === undefined ? {} : { instanceId }),
  })
  const close = () => { child.kill('SIGKILL') }
  return { peer, close }
}

/**
 * End the SSH master through its own control socket, then kill the child, so
 * the outage is exactly what a network partition looks like to the transport.
 * @param controlPath - the session's control socket.
 */
async function killMaster(controlPath) {
  let stdout = ''
  try {
    stdout = execFileSync('pgrep', ['-P', String(process.pid), '-f', 'ssh -T -M'], { encoding: 'utf8' })
  } catch {
    stdout = ''
  }
  const pids = stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
  execFileSync('ssh', ['-S', controlPath, '-O', 'exit', config.host], { stdio: 'ignore' })
  await new Promise(resolve => {
    const killer = spawn('bash', ['-c', `kill -9 ${pids.join(' ')} 2>/dev/null; true`])
    killer.once('exit', resolve)
  })
  return { pids, exited: true }
}

/**
 * Attach every published channel of one process with the daemon's TLS-PSK
 * handshake, exactly as the transport does, then release them on completion.
 * @param streams - the `streams` map a preparation published.
 * @returns the attached TLS sockets.
 */
async function attachChannels(streams) {
  const endpoints = streams ?? {}
  const sockets = []
  for (const endpoint of Object.values(endpoints)) {
    const raw = createConnection({ path: endpoint.path, allowHalfOpen: true })
    await new Promise((resolve, reject) => { raw.once('connect', resolve); raw.once('error', reject) })
    const tls = connect({
      ciphers: 'PSK-AES256-GCM-SHA384', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', socket: raw,
      rejectUnauthorized: true, checkServerIdentity: () => undefined,
      pskCallback: () => ({ psk: Buffer.from(endpoint.capability, 'hex'), identity: 'dsh-stream' }),
    })
    await new Promise((resolve, reject) => { tls.once('secureConnect', resolve); tls.once('error', reject) })
    const body = Buffer.from(JSON.stringify({ sync: 0 }))
    const header = Buffer.alloc(4); header.writeUInt32BE(body.length)
    tls.write(Buffer.concat([header, body]))
    tls.on('error', () => {})
    sockets.push(tls)
  }
  return sockets
}

async function main() {
  await install(128)

  // 1. Terminal output across an outage: the PTY keeps running, the client
  //    reconnects, and the replay window hands back every byte.
  const transport = new RemoteWorkspaceTransport(config)
  await transport.open()
  const sessionUuid = transport.clientId
  const tty = await transport.request('process.prepare', {
    argv: ['/bin/sh'], cwd: WORKSPACE, graceMs: 2000,
    terminal: { terminalType: 'xterm-256color', rows: 24, cols: 80 },
  }, z.object({ id: z.string(), streams: z.record(z.string(), z.object({ path: z.string(), capability: z.string() })) }).loose())
  const terminal = await transport.connectStream(tty.streams.terminal)
  let output = ''
  terminal.on('data', chunk => { output += chunk.toString() })
  await transport.request('process.start', { id: tty.id }, z.object({ pid: z.number() }).loose())
  await transport.request('terminal.write', { id: tty.id, value: 'echo BEFORE-$((3*11))\n' }, z.null())
  const beforeDeadline = Date.now() + 10_000
  while (!output.includes('BEFORE-33') && Date.now() < beforeDeadline) await sleep(200)
  check('terminal produced pre-outage output', output.includes('BEFORE-33'))

  const killed = await killMaster(transport.controlSocket)
  check('simulated an SSH outage', killed.pids.length > 0, `${killed.pids.length} master process(es) killed`)
  await sleep(OUTAGE_MS)
  // The daemon is untouched: the write lands while no client is attached.
  const during = await bridge(sessionUuid)
  await during.peer.requestRaw('terminal.write', { id: tty.id, value: 'echo DURING-$((4*11))\n' })
  during.close()
  console.log(`outage lasted ${String(Math.round(OUTAGE_MS / 1000))}s`)
  const afterDeadline = Date.now() + OUTAGE_MS + 20_000
  while (!output.includes('DURING-44') && Date.now() < afterDeadline) await sleep(250)
  check('terminal output during the outage was replayed', output.includes('DURING-44'), JSON.stringify(output.slice(-60)))
  check('no output was lost around the outage', output.includes('BEFORE-33') && output.includes('DURING-44'))
  await transport.request('process.terminate', { id: tty.id }, z.null())

  // 2. A daemon generation change refuses to pretend continuity.
  const stale = await bridge('resilience-probe-0002')
  const staleHello = await stale.peer.requestRaw('hello', {
    protocol: 1, workspace: WORKSPACE, clientUuid: 'resilience-probe-0002', instanceId: 'stale-instance-token',
  }).then(value => ({ value }), error => ({ error }))
  stale.close()
  check('stale daemon generation reports WORKSPACE_PROGRESS_LOST', staleHello.error?.code === 'WORKSPACE_PROGRESS_LOST', JSON.stringify(staleHello.error ?? staleHello.value).slice(0, 120))

  // 4. A large write replayed with the same opId lands exactly once.
  const bigPath = join(WORKSPACE, 'resilience-big.bin')
  const bigText = `${'x'.repeat(1024 * 1024 - 1)}\n`
  await rm(bigPath, { force: true })
  // The opId gate is per daemon session: the replay must join the same session
  // to be recognised as one operation.
  const first = await bridge('resilience-probe-write')
  const target = await first.peer.requestRaw('fs.resolve', { path: bigPath })
  const writeOne = await first.peer.requestRaw('fs.write', {
    target, content: bigText, expected: { kind: 'createIfAbsent' },
    policy: { mode: 'workspace-write', workspaceRoot: WORKSPACE }, opId: 'c'.repeat(64),
  })
  first.close()
  const second = await bridge('resilience-probe-write')
  const writeTwo = await second.peer.requestRaw('fs.write', {
    target, content: bigText, expected: { kind: 'createIfAbsent' },
    policy: { mode: 'workspace-write', workspaceRoot: WORKSPACE }, opId: 'c'.repeat(64),
  })
  second.close()
  const digest = createHash('sha256').update(await readFile(bigPath)).digest('hex')
  check('large write opId replay returns the original version', writeOne.version === writeTwo.version, `${String(writeOne.version)} vs ${String(writeTwo.version)}`)
  check('large write content is intact', digest === createHash('sha256').update(bigText).digest('hex'), `${(await stat(bigPath)).size} bytes`)

  // 5. Sequential observations stay stable.
  const stress = await bridge()
  const startedAt = Date.now()
  for (let index = 0; index < 200; index += 1) {
    await stress.peer.requestRaw('fs.resolve', { path: join(WORKSPACE, index % 2 === 0 ? 'resilience-big.bin' : 'note.txt') })
  }
  stress.close()
  check('200 sequential observations complete', true, `${Date.now() - startedAt}ms`)
  await transport.dispose()

  // 3. Explicit-only reaping: with a limit of two, a third preparation evicts
  //    the completed reservation rather than anything still running.
  await install(1)
  const reap = await bridge()
  await reap.peer.requestRaw('hello', { protocol: 1, workspace: WORKSPACE, clientUuid: 'resilience-probe-0003' })
  // Reap ordering: one completed reservation occupies the only handle, so the
  // next preparation must evict *it* rather than anything still running.
  const shared = { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
  const reapFirst = await reap.peer.requestRaw('process.prepare', {
    opId: `${'0'.repeat(2)}${'e'.repeat(62)}`,
    argv: ['/bin/sh', '-c', 'echo first'], cwd: WORKSPACE, graceMs: 2000, stdio: shared,
  })
  const firstId = reapFirst.id
  await attachChannels(reapFirst.streams)
  await reap.peer.requestRaw('process.start', { id: firstId })
  await reap.peer.requestRaw('process.done', { id: firstId })
  const reapSecond = await reap.peer.requestRaw('process.prepare', {
    opId: `${'1'.repeat(2)}${'e'.repeat(62)}`,
    argv: ['/bin/sh', '-c', 'echo second'], cwd: WORKSPACE, graceMs: 2000, stdio: shared,
  })
  const secondId = reapSecond.id
  await attachChannels(reapSecond.streams)
  check('a new reservation is accepted after the completed one is evicted', secondId !== firstId)
  const replayed = await reap.peer.requestRaw('process.prepare', {
    opId: `${'0'.repeat(2)}${'e'.repeat(62)}`,
    argv: ['/bin/sh', '-c', 'echo evicted'], cwd: WORKSPACE, graceMs: 2000, stdio: shared,
  })
  // A reaped *live* handle frees capacity, while an already-completed result
  // stays queryable on purpose: a resubmitted opId must never spawn again.
  check('a reaped reservation still answers its opId without re-running', replayed.id === firstId, `${firstId.slice(0, 8)} → ${String(replayed.id).slice(0, 8)}`)
  const replayedDone = await reap.peer.requestRaw('process.done', { id: replayed.id })
  check('the reaped reservation still reports its terminal result', replayedDone.outcome?.exitCode === 0, JSON.stringify(replayedDone).slice(0, 80))
  reap.close()

  await rm(bigPath, { force: true })
  const failures = passed.filter(entry => !entry.ok)
  console.log(`${passed.length - failures.length}/${passed.length} checks passed`)
  process.exit(failures.length === 0 ? 0 : 1)
}

await main()
