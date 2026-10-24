/**
 * A4 probe: the mount plugin through a real root plane — daemon-backed
 * providers for a remote root, the official local providers as fallback, and
 * adoption on a registry stub. This is the code path a session's execution
 * world takes on rc.2.
 * Usage: node probe-mount.mjs [remoteRoot]
 */
import { Context } from '@deepseek-ai/cordis'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp } from 'node:fs/promises'
import { rgPath } from '@vscode/ripgrep'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { RemoteWorkspaceState } from '../../packages/mount/src/state.ts'
import { patchEntityPrototype } from '../../packages/mount/src/registry.ts'
import { patchTerminalController } from '../../packages/mount/src/patch.ts'
import { isLocalToolScope } from '../../packages/mount/src/tool-scope.ts'
import SshWorkspaceMount from '../../packages/mount/src/index.ts'
import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const REMOTE_ROOT = process.argv[2] ?? join(homedir(), 'dsh-mount-probe')

const passed = []
function check(name, ok, detail = '') {
  passed.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function sectionText(section) {
  return typeof section?.text === 'function' ? section.text({}) : section?.text ?? ''
}

const LOCAL_ROOT = await mkdtemp(join(tmpdir(), 'dsh-mount-local-'))
const stateFile = join(await mkdtemp(join(tmpdir(), 'dsh-mount-state-')), 'state.json')

// ── a registry stub: the real WorkspaceRegistry needs domain/storage services,
// while this probe exercises exactly the seams the mount patches ─────────────
class FakeEntity {
  constructor(id, record) { this.id = id, this.record = record }
  get path() { return this.record.path }
  get title() { return this.record.title }
  get sessionIds() { return this.record.sessionIds }
  async mutate(fn) { this.record = fn(this.record) }
}
const entities = []
let createCalls = 0
const sessionPaths = new Map()
const missingSessionPaths = new Set()
const invalidSessionPaths = new Map()
const registry = {
  sessionPaths, missingSessionPaths, invalidSessionPaths,
  get: id => entities.find(entity => entity.id === id),
  list: () => [...entities],
  async createCanonical(canonical, title) {
    createCalls += 1
    const entity = new FakeEntity(`w${entities.length + 1}`, {
      path: canonical, title: title ?? canonical.split('/').filter(Boolean).at(-1) ?? '/', sessionIds: [],
    })
    entities.push(entity)
    return entity
  },
  async enqueueOperation(work) { return await work() },
  async delete(id) {
    const index = entities.findIndex(entity => entity.id === id)
    if (index === -1) return false
    entities.splice(index, 1)
    return true
  },
  async indexHeader(header) {
    // Emulates the local realpath: only host-local paths index cleanly.
    if (header.cwd?.startsWith(LOCAL_ROOT)) sessionPaths.set(header.id, header.cwd)
    else invalidSessionPaths.set(header.id, 'realpath failed')
  },
  async resolveByPath(path) {
    if (!path.startsWith(LOCAL_ROOT)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    return entities.find(entity => entity.path === path)
  },
}

function makeAgentFixture(cwd) {
  const agentCtx = new Context()
  const registered = new Map()
  const sections = []
  const definitions = new Map([
    ['read', fakeTool('read', 'file_path')],
    ['write', fakeTool('write', 'file_path')],
    ['edit', fakeTool('edit', 'file_path')],
    ['bash', fakeTool('bash', 'workdir')],
    ['grep', fakeTool('grep', 'path')],
    ['glob', fakeTool('glob', 'path')],
  ])
  const tools = {
    get(name) { return registered.get(name) ?? definitions.get(name) },
    schemas() {
      return [...new Map([...definitions, ...registered]).values()]
        .map(definition => ({ name: definition.name, description: definition.description, parameters: definition.parameters }))
    },
    register(definition) {
      if (registered.has(definition.name)) throw new Error(`duplicate ${definition.name}`)
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  }
  const prompt = {
    section(input) {
      sections.push(input)
      return () => {
        const index = sections.indexOf(input)
        if (index !== -1) sections.splice(index, 1)
      }
    },
    getSectionOrder(name) { return { DEPLOYMENT_PERSONA_PREFIX: 100 }[name] ?? 0 },
  }
  agentCtx.provide('tools', tools)
  agentCtx.provide('systemPrompt', prompt)
  agentCtx.provide('workingDirectory', { ensure: async () => cwd })
  return { agent: { ctx: agentCtx, session: { header: { cwd } } }, tools, registered, sections }
}

function fakeTool(name, field) {
  return {
    name, description: `${name} tool`, parameters: { type: 'object' }, output: { schema: { type: 'string' } },
    async execute(args) { return `${name}:${args?.[field] ?? '<default>'}` },
  }
}

const ctx = new Context()
const fibers = []
const agentMap = new Map()
const agentRoster = {
  list: () => [...agentMap.values()],
  get: id => agentMap.get(id),
}
let composedPreset = 'ssh-workspace-auto'
ctx.provide('agents', agentRoster)
ctx.provide('agentPresets', { composedPreset: () => composedPreset })
// A sessionController stub: rc.2 funnels creation through the agent roster,
// which is exactly the object the plugin must patch.
const sessionCreates = []
const originalCreates = []
ctx.provide('sessionController', {
  agents: {
    ctx: { agents: { create: async input => { sessionCreates.push(input); return { agent: 'minted-agent' } } } },
    async createAgent(sessionId, cwd) { originalCreates.push(cwd); return 'local-agent' },
    agentOptions: () => ({ provider: 'p', model: 'm' }),
  },
})
fibers.push(await ctx.plugin(SessionProjectionRegistry))
fibers.push(await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: LOCAL_ROOT }))
fibers.push(await ctx.plugin(SandboxedFileSystem, { cwd: LOCAL_ROOT }))
fibers.push(await ctx.plugin(LocalSubprocessRuntime))
fibers.push(await ctx.plugin(LocalSandboxProvider))
ctx.provide('workspaceRegistry', registry)
fibers.push(await ctx.plugin(SshWorkspaceMount, {
  install: true, node: process.execPath,
  daemonDir: '~/.dsh-workspace', statePath: stateFile,
  toolPresets: [{ id: 'ssh-workspace', mode: 'both' }, { id: 'ssh-workspace-auto', mode: 'auto' }],
}))

const plugin = ctx.get('sshWorkspace')
check('mount service registered', plugin instanceof SshWorkspaceMount)

const hosts = plugin.hosts
const state = plugin.state
check('attribution sidecar instantiated', state instanceof RemoteWorkspaceState)
// The mount service's own `ctx.fs` must keep resolving the root plane after a
// host is paired: the provider family registers `fs`/`subprocess`/`sandbox`
// under names that also live on the root plane, and an isolate alone shares
// the parent fiber's name-keyed store, which would shadow them for this whole
// context tree (the local half of the plugin would start reading the remote).
const mountFs = plugin.ctx.fs
const runtime = hosts.pair('localhost')
await runtime.ready
check('host runtime is daemon-backed', runtime.connection?.constructor?.name === 'DaemonSshConnection', runtime.connection?.constructor?.name)
check('remote provider family mounted', runtime.fs !== undefined && runtime.subprocess !== undefined && runtime.sandbox !== undefined)
const remoteHello = runtime.connection?.remote
check('daemon advertises its bundled ripgrep', typeof remoteHello?.rg === 'string'
  && remoteHello.rg.endsWith(`/bin/rg-${remoteHello.platform}-${remoteHello.arch}`), `${remoteHello?.platform}/${remoteHello?.arch} rg=${remoteHello?.rg}`)
check('the host family resolves the daemon filesystem', runtime.fs.constructor.name === 'SshFileSystem' && runtime.fs !== mountFs, runtime.fs.constructor.name)
check('the mount context keeps resolving the root filesystem', plugin.ctx.fs.constructor.name !== 'SshFileSystem', plugin.ctx.fs.constructor.name)
const localHome = await plugin.browse(null, homedir())
check('browse on the local machine lists the local home', localHome.path === homedir() && localHome.entries.length > 0, `${localHome.path} entries=${localHome.entries.length}`)
let localError
try { await plugin.browse(null, new URL(import.meta.url).pathname) } catch (error) { localError = String(error) }
check('a local browse of a file fails as local', localError !== undefined && /is not a directory on this machine/u.test(localError), localError)
// A second host must not disturb the first one's family or the root plane.
const secondHost = 'dsh-mount-probe-second.invalid'
hosts.pair(secondHost)
await Promise.resolve()
await Promise.resolve()
const second = hosts.peek(secondHost)
check('a second host builds its own provider family', second !== undefined && second.fs !== runtime.fs && second.fs.constructor.name === 'SshFileSystem')
check('the root filesystem survives a second pairing', plugin.ctx.fs.constructor.name !== 'SshFileSystem', plugin.ctx.fs.constructor.name)

// The remote root must exist on the remote side before it can be adopted.
await new Promise((resolve, reject) => {
  execFile('ssh', ['-T', 'localhost', `rm -rf '${REMOTE_ROOT}' && mkdir -p '${REMOTE_ROOT}'`], error => error === null ? resolve() : reject(error))
})

const adopted = await plugin.adopt({ host: 'localhost', path: REMOTE_ROOT })
check('adopt minted one record', createCalls === 1 && adopted.path === REMOTE_ROOT, `${adopted.path} calls=${createCalls}`)
const again = await plugin.adopt({ host: 'localhost', path: REMOTE_ROOT })
check('adopt is idempotent', createCalls === 1 && again.workspaceId === adopted.workspaceId)
check('attribution sidecar holds the host', state.byWorkspace(adopted.workspaceId)?.host === 'localhost')

// ── agent preset policy ─────────────────────────────────────────────────────
const fixture = makeAgentFixture(REMOTE_ROOT)
agentMap.set('session-preset', fixture.agent)
ctx.emit('agent/created', { agent: fixture.agent })
check('the auto preset installs remote aliases on a created agent', fixture.registered.has('remote_read'))
check('the auto preset hides local counterparts', fixture.tools.get('read', fixture.agent) === undefined && fixture.tools.get('grep', fixture.agent) === undefined)
check('the auto preset installs its prompt', fixture.sections.some(section => sectionText(section).includes('disabled')))
composedPreset = 'ssh-workspace'
ctx.emit('agent-preset/selected', 'session-preset', composedPreset)
check('switching to the both preset restores local tools', fixture.tools.get('read', fixture.agent) !== undefined)
check('switching presets keeps the remote aliases', fixture.registered.has('remote_read'))
composedPreset = 'ssh-workspace-auto'
ctx.emit('agent-preset/selected', 'session-preset', composedPreset)
check('switching back to auto hides local tools again', fixture.tools.get('read', fixture.agent) === undefined)
ctx.emit('agent/disposed', { agent: fixture.agent })
check('disposing the agent removes the aliases', fixture.registered.size === 0)
check('disposing the agent restores local tools', fixture.tools.get('read', fixture.agent) !== undefined)

// ── remote-tool guard and turn gate ────────────────────────────────────────
const blocked = plugin.guard(REMOTE_ROOT, 'standard')
check('the guard blocks an unconfigured preset in a remote workspace', blocked.blocked && blocked.reason?.includes('SSH Workspace'), JSON.stringify(blocked))
check('the guard allows a remote-tool preset', !plugin.guard(REMOTE_ROOT, 'ssh-workspace').blocked)
check('the guard leaves local workspaces alone', !plugin.guard(LOCAL_ROOT, 'standard').blocked)
check('the guard treats a missing preset as blocked', plugin.guard(REMOTE_ROOT, undefined).blocked)

const standardFixture = makeAgentFixture(REMOTE_ROOT)
agentMap.set('session-standard', standardFixture.agent)
composedPreset = 'standard'
ctx.emit('agent/created', { agent: standardFixture.agent })
check('standard installs no remote aliases', standardFixture.registered.size === 0)
let standardNext = 0
let standardError
try {
  await ctx.waterfall('agent/pre-step', { agent: standardFixture.agent, messages: [{}] }, async () => {
    standardNext += 1
    return { kind: 'enter', messages: [] }
  })
} catch (error) {
  standardError = error
}
check('the turn gate refuses an unconfigured preset', standardNext === 0 && standardError?.message.includes('SSH Workspace'), String(standardError))
ctx.emit('agent/disposed', { agent: standardFixture.agent })

const bothFixture = makeAgentFixture(REMOTE_ROOT)
agentMap.set('session-both', bothFixture.agent)
composedPreset = 'ssh-workspace'
ctx.emit('agent/created', { agent: bothFixture.agent })
let bothNext = 0
let bothDecision
let bothError
try {
  bothDecision = await ctx.waterfall('agent/pre-step', { agent: bothFixture.agent, messages: [{}] }, async () => {
    bothNext += 1
    return { kind: 'enter', messages: [] }
  })
} catch (error) {
  bothError = error
}
check('the turn gate allows a remote-tool preset', bothNext === 1 && bothDecision?.kind === 'enter', String(bothError ?? bothDecision))
ctx.emit('agent/disposed', { agent: bothFixture.agent })

const localFixture = makeAgentFixture(LOCAL_ROOT)
agentMap.set('session-local', localFixture.agent)
composedPreset = 'standard'
ctx.emit('agent/created', { agent: localFixture.agent })
let localNext = 0
await ctx.waterfall('agent/pre-step', { agent: localFixture.agent, messages: [{}] }, async () => {
  localNext += 1
  return { kind: 'enter', messages: [] }
})
check('the turn gate leaves local workspaces alone', localNext === 1)
ctx.emit('agent/disposed', { agent: localFixture.agent })

// ── tools/execute scope ─────────────────────────────────────────────────────
const scopeHits = []
const runScope = async name => {
  await ctx.waterfall('tools/execute', { name, agent: { session: { header: { cwd: REMOTE_ROOT } } } }, async () => {
    scopeHits.push([name, isLocalToolScope()])
    return { ok: true }
  })
}
await runScope('read')
await runScope('remote_read')
await runScope('terminal_open')
check('ordinary tools get the local scope', scopeHits.find(([name]) => name === 'read')?.[1] === true)
check('remote aliases get the remote scope', scopeHits.find(([name]) => name === 'remote_read')?.[1] === false)
check('terminal tools get the remote scope', scopeHits.find(([name]) => name === 'terminal_open')?.[1] === false)

// ── fs routing ──────────────────────────────────────────────────────────────
const remoteReads = []
const originalReadText = runtime.fs.readText.bind(runtime.fs)
runtime.fs.readText = async (...args) => { remoteReads.push(args); return await originalReadText(...args) }
const policy = { mode: 'workspace-write', workspaceRoot: REMOTE_ROOT }
const remoteTarget = await runtime.fs.resolve(join(REMOTE_ROOT, 'mount-note.txt'))
await runtime.fs.writeText(remoteTarget, 'mounted\n', { kind: 'createIfAbsent' }, undefined, policy)
const viaRoot = await ctx.fs.readText(remoteTarget)
check('ctx.fs reads a remote target through the host', viaRoot === 'mounted\n' && remoteReads.length === 1, `reads=${remoteReads.length}`)

const localTarget = await ctx.fs.resolve(join(LOCAL_ROOT, 'local-note.txt'))
await ctx.fs.writeText(localTarget, 'local\n', { kind: 'createIfAbsent' }, undefined, { mode: 'workspace-write', workspaceRoot: LOCAL_ROOT })
check('ctx.fs keeps local writes local', (await ctx.fs.readText(localTarget)) === 'local\n' && remoteReads.length === 1)

const resolves = []
const originalResolve = runtime.fs.resolve.bind(runtime.fs)
runtime.fs.resolve = async (...args) => { resolves.push(args); return await originalResolve(...args) }
const relative = await ctx.fs.resolve('mount-note.txt', { cwd: REMOTE_ROOT })
check('a relative path under a remote cwd routes remote', relative.targetKey === join(REMOTE_ROOT, 'mount-note.txt') && resolves.length === 1, String(relative.targetKey))

// ── adjacent probes: upstream discovery walks above a session cwd ───────────
check('an ancestor-adjacent spelling attributes to the host, not local', state.adjacent(join(dirname(REMOTE_ROOT), '.git'))?.host === 'localhost')
check('an unrelated spelling stays unattributed', state.adjacent('/nowhere/at/.git') === undefined)
const denied = join(LOCAL_ROOT, 'denied')
await mkdir(denied, { mode: 0o000 })
await state.put({ workspaceId: 'denied-ws', host: 'localhost', path: join(denied, 'ws'), title: 'denied', createdAt: new Date().toISOString() })
const before = resolves.length
let deniedError
try { await ctx.fs.resolve(join(denied, '.git')) } catch (error) { deniedError = error }
check('an untraversable local probe falls back to the adjacent host', resolves.length === before + 1 && deniedError !== undefined, `remote calls=${resolves.length - before} error=${deniedError === undefined ? 'none' : String(deniedError).slice(0, 60)}`)
await chmod(denied, 0o755)

// ── subprocess routing ──────────────────────────────────────────────────────
const handle = ctx.subprocess.spawn({
  argv: ['/bin/echo', 'mount-42'], cwd: REMOTE_ROOT, graceMs: 3000,
  stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
})
let out = ''
handle.stdout?.on('data', chunk => { out += chunk.toString() })
await handle.done
check('a spawn under a remote cwd uses the remote provider', handle.constructor.name === 'RemoteProcess' && out.includes('mount-42'), `${handle.constructor.name} out=${JSON.stringify(out)}`)

const rgHandle = ctx.subprocess.spawn({
  argv: [rgPath, '--version'], cwd: REMOTE_ROOT, graceMs: 5000,
  stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
})
let rgOut = ''
rgHandle.stdout?.on('data', chunk => { rgOut += chunk.toString() })
await rgHandle.done
check('the packaged ripgrep runs through the daemon binary', rgHandle.constructor.name === 'RemoteProcess'
  && /ripgrep/u.test(rgOut) && remoteHello?.rg !== null, `${rgHandle.constructor.name} out=${JSON.stringify(rgOut.trim())}`)

const localHandle = ctx.subprocess.spawn({
  argv: ['/bin/echo', 'local-42'], cwd: LOCAL_ROOT, graceMs: 3000,
  stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
})
await localHandle.done
check('a spawn under a local cwd stays local', localHandle.constructor.name !== 'RemoteProcess', localHandle.constructor.name)

await state.put({ workspaceId: 'unpaired', host: 'no-such-host', path: '/nowhere/at/all', title: 'nowhere', createdAt: new Date().toISOString() })
let threw = false
try {
  ctx.subprocess.spawn({ argv: ['true'], cwd: '/nowhere/at/all', graceMs: 3000, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
} catch (error) { threw = /not connected/u.test(String(error)) }
check('a sync spawn on an unpaired host fails loudly', threw)

// ── sandbox routing ─────────────────────────────────────────────────────────
const confinements = []
const originalConfine = runtime.sandbox.confine.bind(runtime.sandbox)
runtime.sandbox.confine = async (...args) => { confinements.push(args[0]); return await originalConfine(...args) }
const confinement = await ctx.sandbox.confine(['/bin/echo', 'hi'], { mode: 'workspace-write', workspaceRoot: REMOTE_ROOT })
check('sandbox confinement resolves on the owning host', confinements.length === 1 && confinement !== undefined && confinement !== null, `calls=${confinements.length}`)

// ── registry seams ──────────────────────────────────────────────────────────
const entity = registry.get(adopted.workspaceId)
entity.host = { readSessionHeader: async () => ({ cwd: REMOTE_ROOT }), rememberSessionPath() {} }
patchEntityPrototype(Object.getPrototypeOf(entity), state)
await entity.attachSession('s1')
check('a session with the remote cwd attaches', entity.record.sessionIds.includes('s1'), JSON.stringify(entity.record.sessionIds))

entity.host = { readSessionHeader: async () => ({ cwd: LOCAL_ROOT }), rememberSessionPath() {} }
let attachThrew = false
try { await entity.attachSession('s2') } catch (error) { attachThrew = /does not match the remote workspace path/u.test(String(error)) }
check('a session with a foreign cwd is rejected', attachThrew)

await registry.indexHeader({ id: 's3', cwd: REMOTE_ROOT })
check('a resumed remote session re-indexes to the remote path', sessionPaths.get('s3') === REMOTE_ROOT && !invalidSessionPaths.has('s3'))

const viaFallback = await registry.resolveByPath(REMOTE_ROOT)
check('resolveByPath falls back to the remote record', viaFallback?.id === adopted.workspaceId, String(viaFallback?.id))

// ── terminal controller patch ───────────────────────────────────────────────
const base = { subprocess: 'local-subprocess', sandboxPolicy: 'policy', workingDirectory: 'cwd' }
const controller = { execution: () => base }
patchTerminalController(controller, hosts, state)
const remoteExecution = controller.execution({ session: { header: { cwd: join(REMOTE_ROOT, 'mount-note.txt') } } })
check('terminal execution swaps in the host provider', remoteExecution.subprocess === runtime.subprocess)
check('terminal execution leaves local sessions alone', controller.execution({ session: { header: { cwd: LOCAL_ROOT } } }) === base)

// ── session controller patch ────────────────────────────────────────────────
const sessionController = ctx.get('sessionController')
const minted = await sessionController.agents.createAgent('session-x', REMOTE_ROOT, { agentPreset: 'preset-a', setup: 'setup-fn' })
check('remote session creation mints through the roster', minted === 'minted-agent' && originalCreates.length === 0 && sessionCreates.length === 1, `original=${originalCreates.length} minted=${sessionCreates.length}`)
const input = sessionCreates[0]
check('the mint request mirrors upstream', input?.sessionId === 'session-x' && input.meta?.cwd === REMOTE_ROOT && input.meta?.agentPreset === 'preset-a' && input.agentOptions?.provider === 'p' && input.setup === 'setup-fn')
const localMinted = await sessionController.agents.createAgent('session-y', LOCAL_ROOT, {})
check('local session creation keeps the original path', localMinted === 'local-agent' && originalCreates[0] === LOCAL_ROOT, `original=${originalCreates.length}`)
let sessionError
try { await sessionController.agents.createAgent('session-z', '/nowhere/at/all', {}) } catch (error) { sessionError = error }
check('a remote cwd on an unreachable host fails loudly without minting locally', sessionError !== undefined && /no-such-host/u.test(String(sessionError)) && sessionCreates.length === 1 && originalCreates.length === 1, String(sessionError))

// ── host recovery ───────────────────────────────────────────────────────────
// A failed startup handshake evicts the runtime from the pool; the next
// session creation must pair the host again instead of failing until restart.
await hosts.dispose()
check('disposing the pool forgets every host runtime', hosts.peek('localhost') === undefined)
const reconnected = await sessionController.agents.createAgent('session-r', REMOTE_ROOT, {})
check('session creation reconnects a host after its runtime was evicted', reconnected === 'minted-agent' && sessionCreates.length === 2, `minted=${sessionCreates.length}`)

// ── deletion bookkeeping ────────────────────────────────────────────────────
await registry.delete(adopted.workspaceId)
check('deleting a workspace drops its attribution', state.byWorkspace(adopted.workspaceId) === undefined)

for (const fiber of fibers.reverse()) await fiber.dispose()
console.log(`${passed.filter(Boolean).length}/${passed.length} checks passed`)
process.exit(passed.every(Boolean) ? 0 : 1)
