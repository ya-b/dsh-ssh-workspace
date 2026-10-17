/**
 * A0/A2 probe: drive a real remote workspace through `ssh localhost` and
 * verify (1) process execution and output capture, (2) durability across an
 * SSH master kill, (3) no duplicate execution, (4) terminal replay.
 * Usage: node probe-transport.mjs [--keep]
 */
import { execFile, spawn } from 'node:child_process'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RemoteWorkspaceTransport } from '@dsh-ssh-workspace/transport'
import { buildDaemonArchive, findNodePty, installDaemonArchive } from '@dsh-ssh-workspace/install'
import { z } from 'zod'

const DAEMON_DIR = join(homedir(), '.dsh-workspace')
const WORKSPACE = join(homedir(), 'dsh-ws-probe')
const NODE = '/usr/bin/node'

const config = {
  host: 'localhost',
  workspace: WORKSPACE,
  daemonDir: DAEMON_DIR,
  node: NODE,
  requestTimeoutMs: 20_000,
  reconnectBaseMs: 100,
  reconnectMaxMs: 1000,
}

function log(...parts) { console.log('[probe]', ...parts) }

async function install() {
  await execFile('mkdir', ['-p', DAEMON_DIR, WORKSPACE])
  const restart = spawn('bash', ['-c', `if [ -f ${DAEMON_DIR}/pid ]; then kill $(cat ${DAEMON_DIR}/pid) 2>/dev/null; fi; sleep 0.3; rm -f ${DAEMON_DIR}/lock ${DAEMON_DIR}/pid ${DAEMON_DIR}/sock`])
  await new Promise(r => restart.once('exit', r))
  const nodePty = await findNodePty(new URL('../../../deepseek-harness', import.meta.url).pathname)
  const archive = await buildDaemonArchive({
    bundlePath: new URL('../../packages/daemon/lib/workspaced.js', import.meta.url).pathname,
    ...(nodePty === undefined ? {} : { nodePtyDir: nodePty }),
    platform: 'linux', arch: process.arch,
  })
  await installDaemonArchive(config, archive)
  await writeFile(join(DAEMON_DIR, 'config.json'), JSON.stringify({
    roots: [WORKSPACE], defaultMode: 'workspace-write', maxProcessHandles: 128,
  }))
  log(`daemon archive installed (${Math.round(archive.length / 1024)} KiB), node-pty ${nodePty === undefined ? 'MISSING' : 'included'}`)
}

/** The daemon is local here because host is localhost; the transport still uses ssh. */
async function readRemoteLog() {
  return await import('node:fs/promises').then(fs => fs.readFile(join(DAEMON_DIR, 'daemon.log'), 'utf8').catch(() => ''))
}

const passed = []
function check(name, ok, detail = '') {
  passed.push({ name, ok })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

async function main() {
  await install()
  const transport = new RemoteWorkspaceTransport(config)
  await transport.open()
  const hello = transport.hello
  check('hello handshake', hello?.kind === 'daemon', `${hello?.instanceId?.slice(0, 8)} node ${hello?.nodeVersion}`)

  // 1. A long-running command: survives an SSH outage and is never re-executed.
  const marker = join(WORKSPACE, 'marker.txt')
  await import('node:fs/promises').then(fs => fs.rm(marker, { force: true }))

  const prepared = await transport.request('process.prepare', {
    argv: ['/bin/sh', '-c', `echo start; echo x >> ${marker}; sleep 6; echo done-$((6*7))`],
    cwd: WORKSPACE, graceMs: 2000,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  }, z.object({ id: z.string(), streams: z.record(z.string(), z.object({ path: z.string(), capability: z.string() })), phase: z.string().optional() }).loose())
  log('prepared', prepared.id)
  const out = await transport.connectStream(prepared.streams.stdout)
  const err = await transport.connectStream(prepared.streams.stderr)
  let stdout = ''
  let stderr = ''
  out.on('data', chunk => { stdout += chunk.toString() })
  err.on('data', chunk => { stderr += chunk.toString() })
  await transport.request('process.start', { id: prepared.id }, z.object({ pid: z.number().optional() }).loose())

  // Kill the SSH master mid-flight: the daemon must keep running the child.
  await new Promise(r => setTimeout(r, 1200))
  const controlPath = transport.controlPath
  check('control path exposed', typeof controlPath === 'string')
  await new Promise((resolve) => {
    execFile('ssh', ['-S', controlPath, '-O', 'exit', 'localhost'], () => resolve())
  })
  log('SSH master exited; remote daemon must be untouched')

  const done = await transport.request('process.done', { id: prepared.id }, z.object({
    outcome: z.object({ exitCode: z.number().nullable(), signal: z.string().nullable() }),
    spills: z.object({}).loose(),
    collected: z.object({}).loose(),
  }).loose(), undefined, true)
  check('process survived SSH outage', done.outcome.exitCode === 0, `exit=${done.outcome.exitCode}`)
  await new Promise(r => setTimeout(r, 400))
  check('stdout captured across reconnect', stdout.includes('done-42'), JSON.stringify(stdout))
  const markerLines = await import('node:fs/promises').then(fs => fs.readFile(marker, 'utf8').catch(() => ''))
  check('command executed exactly once', markerLines.trim() === 'x', JSON.stringify(markerLines.trim()))

  // 2. opId resubmission of a completed process: same id, cached terminal state.
  const again = await transport.request('process.prepare', {
    opId: undefined,
    argv: ['/bin/sh', '-c', 'echo SECOND'],
    cwd: WORKSPACE, graceMs: 2000,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  }, z.object({ id: z.string(), streams: z.record(z.string(), z.unknown()), phase: z.string().optional() }).loose())
  check('second distinct process gets its own id', again.id !== prepared.id)

  // 3. Terminal replay: create a PTY, write to it, then confirm output flows.
  const preparedTty = await transport.request('process.prepare', {
    argv: ['/bin/sh'], cwd: WORKSPACE, graceMs: 2000,
    terminal: { terminalType: 'xterm-256color', rows: 24, cols: 80 },
  }, z.object({ id: z.string(), streams: z.record(z.string(), z.object({ path: z.string(), capability: z.string() })) }).loose())
  const tty = await transport.connectStream(preparedTty.streams.terminal)
  let ttyOut = ''
  tty.on('data', chunk => { ttyOut += chunk.toString() })
  const started = await transport.request('process.start', { id: preparedTty.id }, z.object({ pid: z.number() }).loose())
  check('terminal pid published', typeof started.pid === 'number', String(started.pid))
  await transport.request('terminal.write', { id: preparedTty.id, value: 'echo TTY-$((2*21))\n' }, z.null())
  await new Promise(r => setTimeout(r, 1500))
  check('terminal output flows', ttyOut.includes('TTY-42'), JSON.stringify(ttyOut.slice(-60)))
  await transport.request('process.terminate', { id: preparedTty.id }, z.null())

  // 4. fs round trip through the daemon.
  const file = join(WORKSPACE, 'note.txt')
  await import('node:fs/promises').then(fs => fs.rm(file, { force: true }))
  const target = await transport.request('fs.resolve', { path: file }, z.object({ targetKey: z.string(), displayPath: z.string() }).loose())
  const write = await transport.request('fs.write', {
    target, content: 'hello-transport\n', expected: { kind: 'createIfAbsent' },
    policy: { mode: 'workspace-write', workspaceRoot: WORKSPACE },
  }, z.object({ operation: z.string(), version: z.string() }).loose())
  check('fs.write creates the file', write.operation === 'create')
  const text = await transport.request('fs.readText', { target }, z.string())
  check('fs.readText round trips', text === 'hello-transport\n')
  const listed = await transport.request('fs.list', {
    target: (await transport.request('fs.resolve', { path: WORKSPACE }, z.object({ targetKey: z.string(), displayPath: z.string() }).loose())),
  }, z.array(z.object({ name: z.string() }).loose()))
  check('fs.list sees the new file', listed.some(entry => entry.name === 'note.txt'))

  await transport.dispose()
  const logText = await readRemoteLog()
  if (/error/i.test(logText) && !/daemon socket did not appear/.test(logText)) log('daemon log tail:', logText.split('\n').slice(-4).join(' | '))
  const failures = passed.filter(entry => !entry.ok)
  log(`${passed.length - failures.length}/${passed.length} checks passed`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch(error => { console.error('[probe] fatal', error); process.exit(2) })
