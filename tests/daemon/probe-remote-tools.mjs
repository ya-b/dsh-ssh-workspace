/**
 * Remote alias probe: delegates official-looking fs/search/bash definitions
 * through the remote_* wrappers without a daemon. Covers scoped registration,
 * dynamic cwd, path rewriting, workspace containment, prompt installation,
 * local-tool hiding, and disposal.
 * Usage: node probe-remote-tools.mjs
 */
import { Context } from '@deepseek-ai/cordis'
import {
  hideLocalTools, installRemoteProjectPrompt, installRemoteTools,
  REMOTE_PROJECT_SECTION, remoteToolName,
} from '../../packages/mount/src/remote-tools.ts'

const passed = []
function check(name, ok, detail = '') {
  passed.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function sectionText(section) {
  return typeof section?.text === 'function' ? section.text({}) : section?.text ?? ''
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
      return () => {
        const index = sections.indexOf(input)
        if (index !== -1) sections.splice(index, 1)
      }
    },
    getSectionOrder(name) {
      return { DEPLOYMENT_PERSONA_PREFIX: 100 }[name] ?? 0
    },
  }
  const tools = {
    get(name) {
      return registered.get(name) ?? definitions.get(name) ?? inherited.get(name)
    },
    schemas() {
      const all = new Map([...inherited, ...definitions, ...registered])
      return [...all.values()].map(definition => ({
        name: definition.name, description: definition.description, parameters: definition.parameters,
      }))
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
    ['grep', fakeDefinition('grep', 'Search files.', 'path', calls)],
    ['glob', fakeDefinition('glob', 'List files.', 'path', calls)],
  ])
  ctx.provide('tools', tools)
  ctx.provide('systemPrompt', prompt)
  ctx.provide('workingDirectory', workingDirectory)
  const agent = { ctx, session: { header: { cwd } } }
  return { agent, calls, registered, inherited, sections, definitions, tools, setCwd: next => { cwd = next } }
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
const installation = installRemoteTools(remote.agent, state)
check('installs every remote alias', installation !== undefined && installation.names.length === 6
  && ['remote_read', 'remote_bash', 'remote_grep', 'remote_glob'].every(name => installation.names.includes(name)),
installation?.names.join(',') ?? 'none')
check('installs no prompt on its own', remote.sections.length === 0)
check('original tools stay visible', remote.registered.has('remote_read') && remote.definitions.has('read'))

const prompt = installRemoteProjectPrompt(remote.agent, installation.record, installation.names, false)
check('installs the prompt section', prompt !== undefined && remote.sections.length === 1 && remote.sections[0].name === REMOTE_PROJECT_SECTION)
check('prompt follows the persona prefix', remote.sections[0]?.order === 101, String(remote.sections[0]?.order))
check('prompt names host and workspace', sectionText(remote.sections[0]).includes('devbox') && sectionText(remote.sections[0]).includes(ROOT))
check('prompt lists installed aliases', sectionText(remote.sections[0]).includes('`remote_read`') && sectionText(remote.sections[0]).includes('`remote_grep`'))
check('both-mode prompt keeps local tools', sectionText(remote.sections[0]).includes('remain available'))
prompt()
check('prompt disposer removes the section', remote.sections.length === 0)

const hiddenPrompt = installRemoteProjectPrompt(remote.agent, installation.record, installation.names, true)
check('auto-mode prompt says local tools are disabled', sectionText(remote.sections[0]).includes('disabled'))
hiddenPrompt()

let localCwd = '/tmp/ssh-workspace-local'
const withLocal = installRemoteProjectPrompt(remote.agent, record, installation.names, false, undefined, () => localCwd)
check('both prompt reports the local cwd', sectionText(remote.sections[0]).includes(JSON.stringify(localCwd)))
check('both prompt keeps the terminal on the host', sectionText(remote.sections[0]).includes('terminal panel'))
localCwd = '/var/tmp/other'
check('both prompt reads the local cwd dynamically', sectionText(remote.sections[0]).includes(JSON.stringify(localCwd)))
withLocal()

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

const grep = remote.registered.get('remote_grep')
const grepValue = await grep.execute({ pattern: 'needle', path: 'src' }, { signal })
check('grep path is rewritten', grepValue === `grep:${ROOT}/packages/app/src`, String(grepValue))
await grep.execute({ pattern: 'needle' }, { signal })
check('grep without a path keeps the default', remote.calls.at(-1)?.args.path === undefined && remote.calls.at(-1)?.name === 'grep')

const glob = remote.registered.get('remote_glob')
const globValue = await glob.execute({ pattern: '**/*.ts', path: 'packages' }, { signal })
check('glob path is rewritten', globValue === `glob:${ROOT}/packages/app/packages`, String(globValue))

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

let grepEscape
try {
  await grep.execute({ pattern: 'needle', path: '/etc' }, { signal })
} catch (error) {
  grepEscape = String(error)
}
check('grep absolute escape is rejected', grepEscape !== undefined && /outside the remote workspace/u.test(grepEscape), grepEscape)

let emptyWorkdir
try {
  await bash.execute({ command: 'pwd', workdir: '  ' }, { signal })
} catch (error) {
  emptyWorkdir = String(error)
}
check('empty bash workdir is rejected', emptyWorkdir !== undefined && /must not be empty/u.test(emptyWorkdir), emptyWorkdir)

await read.execute({ file_path: '/srv/remote-project/abs.txt' }, { signal })
check('absolute path inside the workspace is accepted', remote.calls.at(-1)?.args.file_path === `${ROOT}/abs.txt`)

const restore = hideLocalTools(remote.agent, installation.names)
check('hide installs a view filter', restore !== undefined)
check('hidden local tools disappear from get', remote.tools.get('read', remote.agent) === undefined && remote.tools.get('grep', remote.agent) === undefined)
check('remote aliases remain visible', remote.tools.get('remote_read', remote.agent) !== undefined)
const hiddenSchemas = remote.tools.schemas(remote.agent).map(schema => schema.name)
check('hidden local tools disappear from schemas', !hiddenSchemas.includes('read') && !hiddenSchemas.includes('grep') && hiddenSchemas.includes('remote_read'))
const assembly = { sections: [], contexts: [], tools: [{ name: 'read' }, { name: 'grep' }, { name: 'remote_read' }], variables: {} }
const filteredAssembly = await remote.agent.ctx.waterfall('system-prompt/assemble', assembly, {}, async () => assembly)
check('the prompt waterfall filters hidden tools', filteredAssembly.tools.map(tool => tool.name).join(',') === 'remote_read')
restore()
check('restoring brings local tools back', remote.tools.get('read', remote.agent) !== undefined && remote.tools.schemas(remote.agent).some(schema => schema.name === 'read'))

const again = installRemoteTools(remote.agent, state)
check('installation is idempotent until disposed', again === undefined)
installation.dispose()
check('disposing removes the aliases', !remote.registered.has('remote_read') && !remote.registered.has('remote_grep'))
const reinstall = installRemoteTools(remote.agent, state)
check('a disposed installation can be re-applied', reinstall !== undefined && reinstall.names.includes('remote_read'))
reinstall.dispose()

const inheritedAlias = makeAgent()
inheritedAlias.inherited.set('remote_read', fakeDefinition('remote_read', 'Parent alias.', 'file_path', inheritedAlias.calls))
const shadowed = installRemoteTools(inheritedAlias.agent, state)
check('an inherited alias is shadowed for the child workspace', shadowed?.names.includes('remote_read') === true && inheritedAlias.registered.has('remote_read'), shadowed?.names.join(',') ?? 'none')

const local = makeAgent('/home/user/local-project')
const localInstalled = installRemoteTools(local.agent, state)
check('local agents get no aliases', localInstalled === undefined)

const noImage = makeAgent()
const noImageInstalled = installRemoteTools(noImage.agent, state)
check('read_image is optional', noImageInstalled !== undefined && !noImage.registered.has('remote_read_image') && noImage.registered.has('remote_read'))

const withImage = makeAgent()
withImage.definitions.set('read_image', fakeDefinition('read_image', 'Read an image.', 'file_path', withImage.calls))
const withImageInstalled = installRemoteTools(withImage.agent, state)
check('read_image is installed when available', withImageInstalled?.names.includes(remoteToolName('read_image')) === true, withImageInstalled?.names.join(',') ?? 'none')

console.log(`${passed.filter(Boolean).length}/${passed.length} checks passed`)
process.exit(passed.every(Boolean) ? 0 : 1)
