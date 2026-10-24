/**
 * Preset policy probe: maps the two SSH Workspace presets to remote alias
 * installation, prompt text, and the auto-mode local-tool hide lifecycle.
 * Usage: node probe-tool-presets.mjs
 */
import { Context } from '@deepseek-ai/cordis'
import {
  applyRemoteToolPolicy, remoteToolsRequired, resolveRemoteToolPolicy,
} from '../../packages/mount/src/tool-presets.ts'
import { REMOTE_PROJECT_SECTION } from '../../packages/mount/src/remote-tools.ts'

const passed = []
function check(name, ok, detail = '') {
  passed.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function sectionText(section) {
  return typeof section?.text === 'function' ? section.text({}) : section?.text ?? ''
}

const ROOT = '/srv/preset-project'
const record = {
  workspaceId: 'w1', host: 'devbox', path: ROOT,
  title: 'preset-project', createdAt: '2026-01-01T00:00:00.000Z',
}
const state = { covering: path => path === ROOT || path.startsWith(`${ROOT}/`) ? record : undefined }
const presets = [
  { id: 'ssh-workspace', mode: 'both' },
  { id: 'ssh-workspace-auto', mode: 'auto' },
]

function makeAgent(cwd = ROOT, freezeTools = false) {
  const ctx = new Context()
  const registered = new Map()
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
      return registered.get(name) ?? definitions.get(name)
    },
    schemas() {
      const all = new Map([...definitions, ...registered])
      return [...all.values()].map(definition => ({ name: definition.name, description: definition.description, parameters: definition.parameters }))
    },
    register(definition) {
      if (registered.has(definition.name)) throw new Error(`duplicate ${definition.name}`)
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  }
  const definitions = new Map([
    ['read', fakeDefinition('read', 'Read a file.', 'file_path')],
    ['write', fakeDefinition('write', 'Write a file.', 'file_path')],
    ['edit', fakeDefinition('edit', 'Edit a file.', 'file_path')],
    ['bash', fakeDefinition('bash', 'Run bash.', 'workdir')],
    ['grep', fakeDefinition('grep', 'Search files.', 'path')],
    ['glob', fakeDefinition('glob', 'List files.', 'path')],
  ])
  ctx.provide('tools', freezeTools ? Object.freeze(tools) : tools)
  ctx.provide('systemPrompt', prompt)
  ctx.provide('workingDirectory', { ensure: async () => cwd })
  return { ctx, session: { header: { cwd } }, registered, sections, definitions, tools }
}

function fakeDefinition(name, description, field) {
  return {
    name,
    description,
    parameters: { type: 'object' },
    output: { schema: { type: 'string' } },
    async execute(args) {
      return `${name}:${args?.[field] ?? '<default>'}`
    },
  }
}

check('the both preset maps to both', resolveRemoteToolPolicy(presets, 'ssh-workspace', ROOT, state)?.mode === 'both')
check('the auto preset maps to auto', resolveRemoteToolPolicy(presets, 'ssh-workspace-auto', ROOT, state)?.mode === 'auto')
check('an unknown preset is unmapped', resolveRemoteToolPolicy(presets, 'standard', ROOT, state) === undefined)
check('a missing mode defaults to both', resolveRemoteToolPolicy([{ id: 'x' }], 'x', ROOT, state)?.mode === 'both')
check('an unconfigured preset in a remote workspace requires remote tools', remoteToolsRequired(presets, 'standard', ROOT, state))
check('a configured preset in a remote workspace does not', !remoteToolsRequired(presets, 'ssh-workspace', ROOT, state))
check('a local workspace never requires remote tools', !remoteToolsRequired(presets, 'standard', '/home/yb/local', state))
check('a missing preset in a remote workspace requires remote tools', remoteToolsRequired(presets, undefined, ROOT, state))

const bothAgent = makeAgent()
const both = applyRemoteToolPolicy(bothAgent, state, resolveRemoteToolPolicy(presets, 'ssh-workspace', ROOT, state), undefined, () => '/tmp')
check('both installs the remote aliases', both !== undefined && bothAgent.registered.has('remote_read'), [...bothAgent.registered.keys()].join(','))
check('both installs the prompt', bothAgent.sections.length === 1 && bothAgent.sections[0].name === REMOTE_PROJECT_SECTION)
check('both keeps local tools visible', bothAgent.tools.get('read', bothAgent) !== undefined && sectionText(bothAgent.sections[0]).includes('remain available'))
check('both prompt reports the local cwd', sectionText(bothAgent.sections[0]).includes('"/tmp"'))
both.dispose()
check('disposing both removes aliases and prompt', bothAgent.registered.size === 0 && bothAgent.sections.length === 0)

const autoAgent = makeAgent()
const auto = applyRemoteToolPolicy(autoAgent, state, resolveRemoteToolPolicy(presets, 'ssh-workspace-auto', ROOT, state), undefined, () => '/tmp')
check('auto installs the remote aliases', auto !== undefined && autoAgent.registered.has('remote_read'))
check('auto hides local tools', autoAgent.tools.get('read', autoAgent) === undefined && autoAgent.tools.get('grep', autoAgent) === undefined)
check('auto keeps remote aliases visible', autoAgent.tools.get('remote_read', autoAgent) !== undefined)
check('auto prompt says local tools are disabled', sectionText(autoAgent.sections[0]).includes('disabled'))
auto.dispose()
check('disposing auto restores local tools', autoAgent.tools.get('read', autoAgent) !== undefined && autoAgent.tools.get('grep', autoAgent) !== undefined)
check('disposing auto removes the prompt', autoAgent.sections.length === 0)
check('disposing auto removes the aliases', autoAgent.registered.size === 0)

const frozenAgent = makeAgent(ROOT, true)
const degraded = applyRemoteToolPolicy(frozenAgent, state, resolveRemoteToolPolicy(presets, 'ssh-workspace-auto', ROOT, state))
check('auto degrades to both when the view cannot be patched', degraded !== undefined && frozenAgent.registered.has('remote_read') && frozenAgent.tools.get('read', frozenAgent) !== undefined)
check('a degraded auto prompt does not claim tools are disabled', sectionText(frozenAgent.sections[0]).includes('remain available'))
degraded.dispose()

const unknownAgent = makeAgent()
const unknownPolicy = resolveRemoteToolPolicy(presets, 'standard', ROOT, state)
const unknown = unknownPolicy === undefined ? undefined : applyRemoteToolPolicy(unknownAgent, state, unknownPolicy)
check('an unmapped preset installs nothing', unknown === undefined && unknownAgent.registered.size === 0 && unknownAgent.sections.length === 0)

console.log(`${passed.filter(Boolean).length}/${passed.length} checks passed`)
process.exit(passed.every(Boolean) ? 0 : 1)
