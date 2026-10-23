/**
 * Remote alias probe: delegates official-looking fs/bash definitions through
 * the remote_* wrappers without a daemon. Covers scoped registration, dynamic
 * cwd, path rewriting, workspace containment, prompt installation, and local
 * session opt-out.
 * Usage: node probe-remote-tools.mjs
 */
import { Context } from '@deepseek-ai/cordis'
import { installRemoteTools, REMOTE_PROJECT_SECTION, remoteToolName } from '../../packages/mount/src/remote-tools.ts'

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
const state = { covering: path => path === ROOT || path.startsWith(`${ROOT}/`) ? record : undefined }

function makeAgent(cwd = ROOT) {
  const ctx = new Context()
  const calls = []
  const registered = new Map()
  const inherited = new Map()
  const sections = []
  const prompt = {
    section(input) {
      sections.push(input)
      return () => {}
    },
    getSectionOrder(name) {
      return { DEPLOYMENT_PERSONA_PREFIX: 100 }[name] ?? 0
    },
  }
  const tools = {
    get(name) {
      return registered.get(name) ?? definitions.get(name) ?? inherited.get(name)
    },
    register(definition) {
      if (registered.has(definition.name)) throw new Error(`duplicate ${definition.name}`)
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  }
  const workingDirectory = {
    async ensure() {
      return cwd
    },
  }
  const definitions = new Map([
    ['read', fakeDefinition('read', 'Read a file.', 'file_path', calls)],
    ['write', fakeDefinition('write', 'Write a file.', 'file_path', calls)],
    ['edit', fakeDefinition('edit', 'Edit a file.', 'file_path', calls)],
    ['bash', fakeDefinition('bash', 'Run bash.', 'workdir', calls)],
  ])
  ctx.provide('tools', tools)
  ctx.provide('systemPrompt', prompt)
  ctx.provide('workingDirectory', workingDirectory)
  const agent = { ctx, session: { header: { cwd } } }
  return { agent, calls, registered, inherited, sections, definitions, setCwd: next => { cwd = next } }
}

function fakeDefinition(name, description, field, calls) {
  return {
    name,
    description,
    parameters: { type: 'object' },
    output: { schema: { type: 'string' } },
    async execute(args, exec) {
      calls.push({ name, field, args, signal: exec.signal })
      return `${name}:${args?.[field] ?? '<default>'}`
    },
  }
}

const remote = makeAgent()
const installed = installRemoteTools(remote.agent, state)
check('installs every remote alias', installed.length === 4 && installed.includes('remote_read') && installed.includes('remote_bash'), installed.join(','))
check('installs the prompt section', remote.sections.length === 1 && remote.sections[0].name === REMOTE_PROJECT_SECTION)
check('prompt follows the persona prefix', remote.sections[0]?.order === 101, String(remote.sections[0]?.order))
check('prompt names host and workspace', remote.sections[0]?.text.includes('devbox') && remote.sections[0]?.text.includes(ROOT))
check('prompt lists installed aliases', remote.sections[0]?.text.includes('`remote_read`') && remote.sections[0]?.text.includes('`remote_bash`'))
check('original tools stay visible', remote.registered.has('remote_read') && remote.definitions.has('read'))

const signal = new AbortController().signal
const read = remote.registered.get('remote_read')
const readValue = await read.execute({ file_path: 'src/main.ts' }, { signal })
check('relative fs path resolves against the remote cwd', readValue === 'read:/srv/remote-project/src/main.ts', String(readValue))
check('delegated fs call receives the rewritten path', remote.calls.at(-1)?.args.file_path === `${ROOT}/src/main.ts`)
check('delegated call keeps the caller signal', remote.calls.at(-1)?.signal === signal)

remote.setCwd(`${ROOT}/packages/app`)
await read.execute({ file_path: '../README.md' }, { signal })
check('cwd is read at execution time', remote.calls.at(-1)?.args.file_path === `${ROOT}/packages/README.md`, remote.calls.at(-1)?.args.file_path)

const bash = remote.registered.get('remote_bash')
const bashValue = await bash.execute({ command: 'pwd' }, { signal })
check('bash defaults to the current remote cwd', bashValue === 'bash:/srv/remote-project/packages/app', String(bashValue))
await bash.execute({ command: 'ls', workdir: 'src' }, { signal })
check('bash workdir is rewritten', remote.calls.at(-1)?.args.workdir === `${ROOT}/packages/app/src`, remote.calls.at(-1)?.args.workdir)

let escape
try {
  await read.execute({ file_path: '../../../etc/passwd' }, { signal })
} catch (error) {
  escape = String(error)
}
check('relative escape is rejected', escape !== undefined && /outside the remote workspace/u.test(escape), escape)
check('rejected call never reaches the original', remote.calls.every(call => call.args.file_path !== '/etc/passwd'))

let absoluteEscape
try {
  await bash.execute({ command: 'cat /etc/hosts', workdir: '/etc' }, { signal })
} catch (error) {
  absoluteEscape = String(error)
}
check('absolute workdir escape is rejected', absoluteEscape !== undefined && /outside the remote workspace/u.test(absoluteEscape), absoluteEscape)

let emptyWorkdir
try {
  await bash.execute({ command: 'pwd', workdir: '  ' }, { signal })
} catch (error) {
  emptyWorkdir = String(error)
}
check('empty bash workdir is rejected', emptyWorkdir !== undefined && /must not be empty/u.test(emptyWorkdir), emptyWorkdir)

await read.execute({ file_path: '/srv/remote-project/abs.txt' }, { signal })
check('absolute path inside the workspace is accepted', remote.calls.at(-1)?.args.file_path === `${ROOT}/abs.txt`)

const again = installRemoteTools(remote.agent, state)
check('installation is idempotent', again.length === 0 && remote.sections.length === 1)

const inheritedAlias = makeAgent()
inheritedAlias.inherited.set('remote_read', fakeDefinition('remote_read', 'Parent alias.', 'file_path', inheritedAlias.calls))
const shadowed = installRemoteTools(inheritedAlias.agent, state)
check('an inherited alias is shadowed for the child workspace', shadowed.includes('remote_read') && inheritedAlias.registered.has('remote_read'), shadowed.join(','))

const local = makeAgent('/home/user/local-project')
const localInstalled = installRemoteTools(local.agent, state)
check('local agents get no aliases or prompt', localInstalled.length === 0 && local.sections.length === 0)

const noImage = makeAgent()
installRemoteTools(noImage.agent, state)
check('read_image is optional', !noImage.registered.has('remote_read_image') && noImage.registered.has('remote_read'))

const withImage = makeAgent()
withImage.definitions.set('read_image', fakeDefinition('read_image', 'Read an image.', 'file_path', withImage.calls))
const withImageInstalled = installRemoteTools(withImage.agent, state)
check('read_image is installed when available', withImageInstalled.includes(remoteToolName('read_image')), withImageInstalled.join(','))

console.log(`${passed.filter(Boolean).length}/${passed.length} checks passed`)
process.exit(passed.every(Boolean) ? 0 : 1)
