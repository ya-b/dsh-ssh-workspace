/**
 * Auto-upgrade probe: the bootstrap must replace a daemon whose loaded bundle
 * no longer matches the installed `workspaced.js`, must leave it alone while a
 * child process runs, and must retry on the next connection once idle.
 * Usage: node probe-upgrade.mjs
 */
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RemoteWorkspaceTransport } from '@dsh-ssh-workspace/transport'
import { buildDaemonArchive, findNodePty, installDaemonArchive } from '@dsh-ssh-workspace/install'
import { z } from 'zod'

const DAEMON_DIR = join(homedir(), '.dsh-workspace-upgrade-probe')
const WORKSPACE = join(homedir(), 'dsh-ws-upgrade-probe')
const NODE = '/usr/bin/node'
const BUNDLE = new URL('../../packages/daemon/lib/workspaced.js', import.meta.url).pathname

const config = {
  host: 'localhost',
  workspace: WORKSPACE,
  daemonDir: DAEMON_DIR,
  node: NODE,
  requestTimeoutMs: 20_000,
  reconnectBaseMs: 100,
  reconnectMaxMs: 1000,
  autoUpgrade: true,
}

function log(...parts) { console.log('[upgrade-probe]', ...parts) }

const passed = []
function check(name, ok, detail = '') {
  passed.push({ name, ok })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex') }

async function daemonPid() {
  return await readFile(join(DAEMON_DIR, 'pid'), 'utf8').then(text => text.trim()).catch(() => undefined)
}

async function hasChildren(pid) {
  return await new Promise(resolve => {
    execFile('pgrep', ['-P', pid], { timeout: 5000 }, (error) => {
      if (error === null) { resolve(true); return }
      resolve(error.code === 1 ? false : undefined)
    })
  })
}

async function waitForIdle(pid, deadlineMs = 5000) {
  const until = Date.now() + deadlineMs
  for (;;) {
    if (await hasChildren(pid) === false) return true
    if (Date.now() > until) return false
    await new Promise(r => setTimeout(r, 100))
  }
}

async function reset() {
  const pid = await daemonPid()
  if (pid !== undefined && /^[0-9]+$/.test(pid)) {
    const alive = await new Promise(resolve => {
      execFile('kill', ['-0', pid], error => resolve(error === null))
    })
    if (alive) await new Promise(resolve => execFile('kill', [pid], () => resolve()))
  }
  await new Promise(r => setTimeout(r, 300))
  await rm(join(DAEMON_DIR, 'sock'), { force: true })
  await rm(join(DAEMON_DIR, 'pid'), { force: true })
  await rm(join(DAEMON_DIR, 'lock'), { force: true })
  await rm(join(DAEMON_DIR, 'running.digest'), { force: true })
  await mkdir(DAEMON_DIR, { recursive: true })
  await mkdir(WORKSPACE, { recursive: true })
  const nodePty = await findNodePty(new URL('../../../deepseek-harness', import.meta.url).pathname)
  const archive = await buildDaemonArchive({
    bundlePath: BUNDLE,
    ...(nodePty === undefined ? {} : { nodePtyDir: nodePty }),
    platform: 'linux', arch: process.arch,
  })
  await installDaemonArchive(config, archive)
  await writeFile(join(DAEMON_DIR, 'config.json'), JSON.stringify({
    roots: [WORKSPACE], defaultMode: 'workspace-write', maxProcessHandles: 128,
  }))
  log(`bundle installed (${Math.round(archive.length / 1024)} KiB)`)
}

/** Swap the installed bundle, exactly like a deploy would. */
async function replaceBundle(tag) {
  const bytes = await readFile(BUNDLE)
  const next = Buffer.concat([bytes, Buffer.from(`\n// ${tag}\n`)])
  await writeFile(join(DAEMON_DIR, 'workspaced.js.tmp'), next)
  const { rename } = await import('node:fs/promises')
  await rename(join(DAEMON_DIR, 'workspaced.js.tmp'), join(DAEMON_DIR, 'workspaced.js'))
  return sha256(next)
}

async function digestFile() {
  return await readFile(join(DAEMON_DIR, 'running.digest'), 'utf8').then(text => text.trim()).catch(() => undefined)
}

async function main() {
  await reset()
  const first = new RemoteWorkspaceTransport(config)
  await first.open()
  const firstId = first.hello?.instanceId
  check('first connect boots the daemon', typeof firstId === 'string', firstId?.slice(0, 12))
  const installedV1 = sha256(await readFile(join(DAEMON_DIR, 'workspaced.js')))
  check('boot publishes the loaded bundle digest', await digestFile() === installedV1)

  // Idle daemon on an older bundle: the next connection must replace it.
  const v2Digest = await replaceBundle('probe-upgrade v2')
  await first.dispose()
  const second = new RemoteWorkspaceTransport(config)
  await second.open()
  const secondId = second.hello?.instanceId
  check('idle daemon is replaced after a bundle swap', secondId !== undefined && secondId !== firstId, `${secondId?.slice(0, 12)}`)
  check('replacement publishes the new digest', await digestFile() === v2Digest)

  // A live child process must protect the daemon from replacement.
  const prepared = await second.request('process.prepare', {
    argv: ['/bin/sh', '-c', 'sleep 30'],
    cwd: WORKSPACE, graceMs: 2000,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  }, z.object({ id: z.string(), streams: z.record(z.string(), z.object({ path: z.string(), capability: z.string() })) }).loose())
  const out = await second.connectStream(prepared.streams.stdout)
  const err = await second.connectStream(prepared.streams.stderr)
  out.on('data', () => {})
  err.on('data', () => {})
  await second.request('process.start', { id: prepared.id }, z.object({ pid: z.number().optional() }).loose())
  const v3Digest = await replaceBundle('probe-upgrade v3')
  const third = new RemoteWorkspaceTransport(config)
  await third.open()
  check('busy daemon is not replaced', third.hello?.instanceId === secondId)
  check('busy daemon keeps its old digest', await digestFile() !== v3Digest)

  // Once idle, the next connection performs the deferred upgrade.
  await second.request('process.terminate', { id: prepared.id }, z.null())
  const pid = await daemonPid()
  check('daemon child exits after terminate', pid === undefined || await waitForIdle(pid) !== false)
  await second.dispose()
  await third.dispose()
  const fourth = new RemoteWorkspaceTransport(config)
  await fourth.open()
  check('deferred upgrade happens once idle', fourth.hello?.instanceId !== undefined && fourth.hello.instanceId !== secondId, fourth.hello?.instanceId?.slice(0, 12))
  check('deferred upgrade publishes the newest digest', await digestFile() === v3Digest)
  await fourth.dispose()

  const failures = passed.filter(entry => !entry.ok)
  log(`${passed.length - failures.length}/${passed.length} checks passed`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch(error => { console.error('[upgrade-probe] fatal', error); process.exit(2) })
