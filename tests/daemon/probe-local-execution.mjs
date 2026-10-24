/**
 * Local-tool execution probe: the tool scope, root-router bypasses, the local
 * working directory, and the local sandbox policy. No daemon or ssh needed.
 * Usage: node probe-local-execution.mjs
 */
import { posix } from 'node:path'
import {
  createLocalCwdStore, patchLocalSandboxPolicy, patchLocalWorkingDirectory,
} from '../../packages/mount/src/local-execution.ts'
import { patchFileSystem, patchSandbox, patchSubprocess } from '../../packages/mount/src/patch.ts'
import { isHostToolName, isLocalToolScope, runToolScope } from '../../packages/mount/src/tool-scope.ts'

const passed = []
function check(name, ok, detail = '') {
  passed.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

const ROOT = '/srv/remote-project'
const record = {
  workspaceId: 'w1', host: 'devbox', path: ROOT,
  title: 'remote-project', createdAt: '2026-01-01T00:00:00.000Z',
}
const state = {
  covering: path => path === ROOT || path.startsWith(`${ROOT}/`) ? record : undefined,
  adjacent: path => path === '/denied' ? record : undefined,
}

check('the local scope is reported', await runToolScope({ kind: 'local' }, async () => isLocalToolScope()))
check('the default scope is not local', isLocalToolScope() === false)
check('remote aliases stay on the host', isHostToolName('remote_read') && isHostToolName('remote_bash'))
check('terminal tools stay on the host', isHostToolName('terminal_open') && isHostToolName('terminal_send'))
check('ordinary tools stay local', !isHostToolName('read') && !isHostToolName('bash') && !isHostToolName('grep'))

const localCalls = []
let denied = false
const localFs = {
  async resolve(path, opts) {
    localCalls.push(['resolve', path, opts?.cwd])
    return posix.isAbsolute(path) ? path : posix.resolve(opts?.cwd ?? '/', path)
  },
  async stat(target) {
    localCalls.push(['stat', target])
    if (denied) throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' })
    return { type: 'directory' }
  },
  async lstat(target) { localCalls.push(['lstat', target]); return { type: 'file' } },
  async readText(target) {
    localCalls.push(['readText', target])
    if (denied) throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' })
    return `local:${target}`
  },
  async streamText(target) { localCalls.push(['streamText', target]); return [target] },
  async readBytes(target) { localCalls.push(['readBytes', target]); return new Uint8Array() },
  async readByteRange(target) { localCalls.push(['readByteRange', target]); return new Uint8Array() },
  async listDir(target) { localCalls.push(['listDir', target]); return [] },
  async writeText(target) { localCalls.push(['writeText', target]); return `local-write:${target}` },
  async editText(target) { localCalls.push(['editText', target]); return `local-edit:${target}` },
  async watch(target) { localCalls.push(['watch', target]); return async () => {} },
  processPath(target) { return target },
}
const remoteCalls = []
const remoteFs = {
  async resolve(path) { remoteCalls.push(['resolve', path]); return path },
  async stat(target) { remoteCalls.push(['stat', target]); return { type: 'directory' } },
  async lstat(target) { remoteCalls.push(['lstat', target]); return { type: 'file' } },
  async readText(target) { remoteCalls.push(['readText', target]); return `remote:${target}` },
  async streamText(target) { remoteCalls.push(['streamText', target]); return [target] },
  async readBytes(target) { remoteCalls.push(['readBytes', target]); return new Uint8Array() },
  async readByteRange(target) { remoteCalls.push(['readByteRange', target]); return new Uint8Array() },
  async listDir(target) { remoteCalls.push(['listDir', target]); return [] },
  async writeText(target) { remoteCalls.push(['writeText', target]); return `remote-write:${target}` },
  async editText(target) { remoteCalls.push(['editText', target]); return `remote-edit:${target}` },
  async watch(target) { remoteCalls.push(['watch', target]); return async () => {} },
  processPath(target) { return target },
}
const hosts = { peek: () => ({ fs: remoteFs }) }
const ctx = { logger: { warn() {}, debug() {} } }
patchFileSystem(ctx, localFs, hosts, state)

check('an unscoped path still routes to the host', (await localFs.readText(`${ROOT}/README.md`)) === `remote:${ROOT}/README.md`)
check('the unscoped read reached the remote provider', remoteCalls.at(-1)?.[1] === `${ROOT}/README.md`)

const beforeLocal = remoteCalls.length
const localRead = await runToolScope({ kind: 'local' }, async () => localFs.readText(`${ROOT}/README.md`))
check('a local tool reads the local path', localRead === `local:${ROOT}/README.md`, localRead)
check('a local tool never reaches the host', remoteCalls.length === beforeLocal)
check('a local write stays local', (await runToolScope({ kind: 'local' }, async () => localFs.writeText(`${ROOT}/out.txt`))) === `local-write:${ROOT}/out.txt`)

denied = true
const beforeDenied = remoteCalls.length
let deniedError
try {
  await runToolScope({ kind: 'local' }, async () => localFs.readText('/denied'))
} catch (error) {
  deniedError = error
}
check('a local permission failure is not retried on the host', deniedError?.code === 'EACCES' && remoteCalls.length === beforeDenied)
let probeError
try {
  await localFs.readText('/denied')
} catch (error) {
  probeError = error
}
check('the unscoped adjacent probe still reaches the host', probeError === undefined && remoteCalls.at(-1)?.[1] === '/denied', `error=${String(probeError)} last=${JSON.stringify(remoteCalls.at(-1))}`)
denied = false

const beforeRemote = localCalls.length
const remoteRead = await runToolScope({ kind: 'remote', record }, async () => localFs.readText(`${ROOT}/README.md`))
check('a remote scope reads the host path', remoteRead === `remote:${ROOT}/README.md`, remoteRead)
check('a remote scope never reaches the local provider', localCalls.length === beforeRemote)

let localSpawns = 0
let remoteSpawns = 0
const subprocess = {
  spawn(spec) { localSpawns += 1; return { kind: 'local', cwd: spec.cwd } },
  async spawnTerminal(spec) { localSpawns += 1; return { kind: 'local-terminal', cwd: spec.cwd } },
}
const remoteRuntime = {
  fs: remoteFs,
  subprocess: {
    spawn(spec) { remoteSpawns += 1; return { kind: 'remote', cwd: spec.cwd } },
    async spawnTerminal(spec) { remoteSpawns += 1; return { kind: 'remote-terminal', cwd: spec.cwd } },
  },
  sandbox: {
    async confine() { return { kind: 'remote-confine' } },
  },
}
const spawnHosts = { peek: () => remoteRuntime, pair: () => remoteRuntime }
patchSubprocess(ctx, subprocess, spawnHosts, state)
check('an unscoped spawn uses the host', subprocess.spawn({ cwd: ROOT, argv: ['echo'] }).kind === 'remote')
check('a local spawn stays local', await runToolScope({ kind: 'local' }, async () => subprocess.spawn({ cwd: ROOT, argv: ['echo'] }).kind === 'local'))
check('a remote spawn uses the host', await runToolScope({ kind: 'remote', record }, async () => subprocess.spawn({ cwd: ROOT, argv: ['echo'] }).kind === 'remote'))
check('a local terminal spawn stays local', (await runToolScope({ kind: 'local' }, async () => subprocess.spawnTerminal({ cwd: ROOT }))).kind === 'local-terminal')
check('spawn counters split by scope', localSpawns === 2 && remoteSpawns === 2, `${localSpawns}/${remoteSpawns}`)

let localConfines = 0
let remoteConfines = 0
const sandbox = { async confine() { localConfines += 1; return { kind: 'local-confine' } } }
const remoteSandboxRuntime = { ...remoteRuntime, sandbox: { async confine() { remoteConfines += 1; return { kind: 'remote-confine' } } } }
patchSandbox(sandbox, { peek: () => remoteSandboxRuntime, pair: () => remoteSandboxRuntime }, state)
await sandbox.confine([], { workspaceRoot: ROOT })
check('an unscoped confine uses the host', remoteConfines === 1 && localConfines === 0)
await runToolScope({ kind: 'local' }, async () => sandbox.confine([], { workspaceRoot: ROOT }))
check('a local confine stays local', localConfines === 1 && remoteConfines === 1)
await runToolScope({ kind: 'remote', record }, async () => sandbox.confine([], { workspaceRoot: ROOT }))
check('a remote confine uses the host', remoteConfines === 2 && localConfines === 1)

const store = createLocalCwdStore('/tmp')
let originalEnsures = 0
let originalSets = 0
const workingDirectory = {
  get: () => ROOT,
  async ensure() { originalEnsures += 1; return ROOT },
  async set(_agent, path) { originalSets += 1; return `${ROOT}/${path}` },
}
patchLocalWorkingDirectory(workingDirectory, state, store, () => localFs)
const remoteAgent = { session: { header: { cwd: ROOT } } }
const localAgent = { session: { header: { cwd: '/home/yb/local-project' } } }
check('an unscoped working directory stays remote', (await workingDirectory.ensure(remoteAgent)) === ROOT && originalEnsures === 1)
check('a local tool gets the local cwd', (await runToolScope({ kind: 'local' }, async () => workingDirectory.ensure(remoteAgent))) === '/tmp')
check('a local get reports the local cwd', await runToolScope({ kind: 'local' }, async () => workingDirectory.get(remoteAgent.session) === '/tmp'))
check('a local cd changes only the local cwd', await runToolScope({ kind: 'local' }, async () => (await workingDirectory.set(remoteAgent, 'work')) === '/tmp/work'), store.of(remoteAgent.session))
check('the local cwd persists for the session', store.of(remoteAgent.session) === '/tmp/work', store.of(remoteAgent.session))
check('the next local ensure reads the changed cwd', (await runToolScope({ kind: 'local' }, async () => workingDirectory.ensure(remoteAgent))) === '/tmp/work')
check('a local session keeps its stock cwd', (await runToolScope({ kind: 'local' }, async () => workingDirectory.ensure(localAgent))) === ROOT && originalEnsures === 2)
check('a remote scope keeps the stock cwd', (await runToolScope({ kind: 'remote', record }, async () => workingDirectory.ensure(remoteAgent))) === ROOT && originalEnsures === 3)
check('the remote directory never received a local cd', store.of(remoteAgent.session) === '/tmp/work' && originalSets === 0)

let originalResolves = 0
const policy = {
  resolve(request = {}) {
    originalResolves += 1
    return { mode: 'workspace-write', workspaceRoot: request.session?.header?.cwd ?? '/fallback' }
  },
}
patchLocalSandboxPolicy(policy, state, store)
check('an unscoped policy stays remote', policy.resolve({ session: remoteAgent.session }).workspaceRoot === ROOT)
check('a local policy uses the local cwd', await runToolScope({ kind: 'local' }, async () => policy.resolve({ session: remoteAgent.session }).workspaceRoot === '/tmp/work'))
check('a local session policy stays its own cwd', await runToolScope({ kind: 'local' }, async () => policy.resolve({ session: localAgent.session }).workspaceRoot === '/home/yb/local-project'))
check('a remote policy stays remote', await runToolScope({ kind: 'remote', record }, async () => policy.resolve({ session: remoteAgent.session }).workspaceRoot === ROOT))
check('the policy resolver is not bypassed', originalResolves === 4, String(originalResolves))

console.log(`${passed.filter(Boolean).length}/${passed.length} checks passed`)
process.exit(passed.every(Boolean) ? 0 : 1)
