/**
 * A4 probe: the daemon-backed realm through the real host-plane router, which
 * is the exact code path a session's execution world takes.
 * Usage: node probe-realm.mjs [remoteRoot]
 */
import { Context } from '@deepseek-ai/cordis'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { RemoteWorkspaceRegistry } from '@dsh-ssh-workspace/realm'
import { homedir } from 'node:os'
import { join } from 'node:path'

const REMOTE_ROOT = process.argv[2] ?? join(homedir(), 'dsh-ws-probe')
const workspace = {
  id: 'probe-workspace', path: REMOTE_ROOT, title: 'probe', transport: 'ssh',
  host: 'localhost', sessionIds: ['probe-session'],
}

const passed = []
function check(name, ok, detail = '') {
  passed.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

const ctx = new Context()
const fibers = []
fibers.push(await ctx.plugin(SessionProjectionRegistry))
fibers.push(await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: REMOTE_ROOT }))
ctx.provide('workspaceRegistry', { list: () => [workspace], get: () => workspace })
fibers.push(await ctx.plugin(RemoteWorkspaceRegistry, { install: true, node: process.execPath }))

const registry = ctx.get('workspaceRuntime')
check('registry service is the daemon-backed subclass', registry instanceof RemoteWorkspaceRegistry)

const world = await registry.worldForWorkspace(workspace)
check('remote world resolved as ssh transport', world.transport === 'ssh', `host=${world.host}`)
check('remote world carries every provider', world.fs !== undefined && world.subprocess !== undefined && world.sandbox !== undefined && world.shell !== undefined)

// The session path must resolve to the very world the workspace path does:
// a session is only remote if its own lookup lands on the realm.
const sessionWorld = await registry.worldForSessionId('probe-session')
check('worldForSessionId resolves through the same realm', sessionWorld === world)
check('the realm does not hand back the host filesystem', world.fs.constructor.name === 'SshFileSystem', world.fs.constructor.name)

const target = await world.fs.resolve(join(REMOTE_ROOT, 'realm-note.txt'))
await import('node:fs/promises').then(fsModule => fsModule.rm(target.targetKey, { force: true }))
const written = await world.fs.writeText(target, 'realm\n', { kind: 'createIfAbsent' })
check('realm fs write', (await world.fs.readText(target)) === 'realm\n', written.version.slice(0, 8))

const handle = world.subprocess.spawn({
  argv: ['/bin/sh', '-c', 'echo realm-$((9*9)); exit 5'], cwd: REMOTE_ROOT, graceMs: 3000,
  stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
})
let out = ''
handle.stdout?.on('data', chunk => { out += chunk.toString() })
const result = await handle.done
check('realm subprocess', result.exitCode === 5 && out.includes('realm-81'), `exit=${result.exitCode} out=${JSON.stringify(out)}`)

check('realm shell executor mounted with the host plane policy', world.shell.sandboxMode === 'workspace-write', String(world.shell.sandboxMode))

const verifier = ctx.get('workspaceRemoteVerifier')
check('remote verifier is provided', verifier !== undefined)
const verified = await verifier.verify('localhost', REMOTE_ROOT)
check('remote verifier canonicalizes through the realm', verified.canonicalPath === REMOTE_ROOT, verified.canonicalPath)
check('remote status is ok', (await verifier.status('localhost', REMOTE_ROOT)) === 'ok')
check('missing directory reported', (await verifier.status('localhost', join(REMOTE_ROOT, 'nope'))) === 'missing-dir')

for (const fiber of fibers.reverse()) await fiber.dispose()
console.log(`${passed.filter(Boolean).length}/${passed.length} checks passed`)
process.exit(passed.every(Boolean) ? 0 : 1)
