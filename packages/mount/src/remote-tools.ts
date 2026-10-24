/**
 * Remote-facing aliases of the official file, search, and bash tools. Adopted
 * remote workspaces live in the official registry with a *remote* cwd, but the
 * stock model still has no way to choose between that machine and the harness
 * machine. These aliases make the choice explicit while delegating every
 * execution detail (schemas, approvals, output rendering, timeouts) to the
 * official definitions.
 *
 * Aliases are registered into the agent scope. Whether an agent gets them is
 * decided by the selected agent preset and the workspace attribution: the
 * standard preset stays local-only, the `both` preset adds aliases beside the
 * local tools, and the `auto` preset additionally hides the local counterparts
 * in adopted remote workspaces. Paths are checked against the workspace record
 * at execution time and rewritten to absolute remote spellings before the
 * original tool runs.
 * @module @dsh-ssh-workspace/mount/remote-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { posix } from 'node:path'
import { canonicalSpelling, within, type RemoteWorkspaceRecord, type RemoteWorkspaceState } from './state.ts'

/** Prompt section inserted just after the deployment/persona prefix. */
export const REMOTE_PROJECT_SECTION = 'ssh-workspace:remote-project'

/** Structural view of the agent fields these aliases depend on. */
export interface RemoteToolAgent {
  readonly ctx: Context
  readonly session: {
    readonly header?: {
      readonly cwd?: string
    }
  }
}

/** Warning sink shared by the preset policy and the installers. */
export interface RemoteToolsLogger {
  warn(message: string): void
}

interface RemoteToolExecution {
  readonly signal: AbortSignal
  readonly [key: string]: unknown
}

interface RemoteToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: unknown
  readonly execute: (args: unknown, exec: RemoteToolExecution) => Promise<unknown>
  readonly [key: string]: unknown
}

interface ToolSchemaLike {
  readonly name: string
  readonly [key: string]: unknown
}

interface ToolRegistryLike {
  get(name: string, scope?: unknown): RemoteToolDefinition | undefined
  schemas(scope?: unknown): readonly ToolSchemaLike[]
  register(definition: RemoteToolDefinition): () => void
}

interface SystemPromptLike {
  section(section: {
    readonly name: string
    readonly order: number
    readonly text: string | (() => string)
    readonly interpolate?: boolean
  }): () => void
  getSectionOrder(name: string): number
}

interface WorkingDirectoryLike {
  ensure(agent: unknown, signal?: AbortSignal): Promise<string>
}

/** The tool schema list one prompt assembly carries. */
interface PromptAssemblyLike {
  readonly tools: readonly { readonly name: string }[]
  readonly [key: string]: unknown
}

type SourceTool = 'read' | 'write' | 'edit' | 'read_image' | 'bash' | 'grep' | 'glob'

interface RemoteToolSpec {
  readonly source: SourceTool
  readonly field: 'file_path' | 'workdir' | 'path'
}

const SPECS: readonly RemoteToolSpec[] = [
  { source: 'read', field: 'file_path' },
  { source: 'write', field: 'file_path' },
  { source: 'edit', field: 'file_path' },
  { source: 'read_image', field: 'file_path' },
  { source: 'bash', field: 'workdir' },
  { source: 'grep', field: 'path' },
  { source: 'glob', field: 'path' },
]

/** Aliases installed by one call; a second call is a no-op until disposal. */
export interface RemoteToolInstallation {
  readonly names: readonly string[]
  readonly record: RemoteWorkspaceRecord
  dispose(): void
}

interface InstalledAlias {
  readonly name: string
  readonly dispose: () => void
}

const installations = new WeakMap<object, RemoteToolInstallation>()
const hiddenTools = new WeakMap<object, ReadonlySet<string>>()
const patchedViews = new WeakSet<object>()

/** The model-facing name of one delegated tool. */
export function remoteToolName(source: SourceTool): string {
  return `remote_${source}`
}

function prefix(record: RemoteWorkspaceRecord): string {
  return `This tool runs on remote SSH host ${JSON.stringify(record.host)} and is bound to the workspace ${JSON.stringify(record.path)}.`
}

function remoteDescription(source: SourceTool, original: string, record: RemoteWorkspaceRecord): string {
  const detail = source === 'bash'
    ? 'Commands execute on the remote machine; the default workdir is the current remote directory.'
    : 'Paths are resolved on the remote machine; relative paths resolve from the current remote directory.'
  return `${prefix(record)} ${detail}\n\n${original}`
}

function localCwdText(localCwd: () => string): string {
  const cwd = localCwd()
  return cwd === '' ? 'the harness process directory' : JSON.stringify(cwd)
}

function remotePrompt(
  record: RemoteWorkspaceRecord,
  tools: readonly string[],
  hideLocal: boolean,
  localCwd: () => string,
): string {
  const available = tools.length === 0
    ? 'No remote-specific tools are available in this session.'
    : `Prefer ${tools.map(name => `\`${name}\``).join(', ')} for files, searches, and commands in this project. They are bound to the host and accept only paths inside the workspace; relative paths resolve from the current remote directory.`
  const local = hideLocal
    ? 'The corresponding original local tools are disabled in this session; use the remote tools for project work. The terminal panel and terminal_* tools stay on the remote host.'
    : `The original local tools remain available beside the remote tools, but they execute on the harness machine, not on ${JSON.stringify(record.host)}; their current working directory is ${localCwdText(localCwd)}. Use remote_* for project work. The terminal panel and terminal_* tools stay on the remote host.`
  return [
    `This project is a remote project: its workspace is ${JSON.stringify(record.path)} on SSH host ${JSON.stringify(record.host)}.`,
    'The remote_* tools, the workspace file UI, and the terminal panel/tools are bound to that machine.',
    available,
    local,
  ].join('\n\n')
}

function registry(agent: RemoteToolAgent): ToolRegistryLike | undefined {
  const tools = agent.ctx.get('tools') as ToolRegistryLike | undefined
  return tools !== undefined
    && typeof tools.get === 'function'
    && typeof tools.schemas === 'function'
    && typeof tools.register === 'function'
    ? tools
    : undefined
}

function promptRegistry(agent: RemoteToolAgent): SystemPromptLike | undefined {
  const prompt = agent.ctx.get('systemPrompt') as SystemPromptLike | undefined
  return prompt !== undefined && typeof prompt.section === 'function' && typeof prompt.getSectionOrder === 'function' ? prompt : undefined
}

async function currentDirectory(agent: RemoteToolAgent, signal: AbortSignal | undefined): Promise<string> {
  const workingDirectory = agent.ctx.get('workingDirectory') as WorkingDirectoryLike | undefined
  if (workingDirectory !== undefined && typeof workingDirectory.ensure === 'function') {
    return await workingDirectory.ensure(agent, signal)
  }
  return agent.session.header?.cwd ?? ''
}

async function rewriteArgs(
  spec: RemoteToolSpec,
  args: unknown,
  agent: RemoteToolAgent,
  record: RemoteWorkspaceRecord,
  exec: RemoteToolExecution,
): Promise<unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return args
  const values = args as Record<string, unknown>
  const raw = values[spec.field]
  if (raw !== undefined && typeof raw !== 'string') return args
  if (raw !== undefined && raw.trim().length === 0) {
    if (spec.source === 'bash') throw new Error(`${remoteToolName(spec.source)}: workdir must not be empty`)
    return args
  }
  if (raw === undefined && spec.source !== 'bash') return args
  const absolute = typeof raw === 'string' && posix.isAbsolute(raw)
  const base = absolute ? record.path : (await currentDirectory(agent, exec.signal)) || record.path
  const resolved = canonicalSpelling(posix.resolve(base, raw ?? base))
  if (!within(record.path, resolved)) {
    throw new Error(`${remoteToolName(spec.source)}: ${JSON.stringify(raw ?? base)} is outside the remote workspace ${JSON.stringify(record.path)} on host ${JSON.stringify(record.host)}`)
  }
  return { ...values, [spec.field]: resolved }
}

function installOne(
  tools: ToolRegistryLike,
  agent: RemoteToolAgent,
  spec: RemoteToolSpec,
  record: RemoteWorkspaceRecord,
  logger: RemoteToolsLogger | undefined,
): InstalledAlias | undefined {
  const source = tools.get(spec.source, agent)
  if (source === undefined) return undefined
  const name = remoteToolName(spec.source)
  const originalExecute = source.execute
  const definition: RemoteToolDefinition = {
    ...source,
    name,
    description: remoteDescription(spec.source, source.description, record),
    execute: async (args, exec) => {
      const rewritten = await rewriteArgs(spec, args, agent, record, exec)
      return await originalExecute.call(source, rewritten, exec)
    },
  }
  try {
    const dispose = tools.register(definition)
    return { name, dispose }
  } catch (error) {
    logger?.warn(`ssh-workspace: failed to register ${name}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * Install the remote_* aliases on one agent. The agent must already carry a
 * remote cwd and a workspace record; local agents are a no-op. Installation is
 * idempotent per agent until the returned installation is disposed.
 * @param agent - live or newly-created agent.
 * @param state - remote workspace sidecar used for host/path attribution.
 * @param logger - optional warning sink for non-fatal registration failures.
 * @returns installed names and their disposer, or undefined when already installed.
 */
export function installRemoteTools(
  agent: RemoteToolAgent,
  state: Pick<RemoteWorkspaceState, 'covering'>,
  logger?: RemoteToolsLogger,
): RemoteToolInstallation | undefined {
  if (installations.has(agent)) return undefined
  const cwd = agent.session.header?.cwd
  if (cwd === undefined || cwd === '') return undefined
  const record = state.covering(cwd)
  if (record === undefined) return undefined
  const tools = registry(agent)
  if (tools === undefined) return undefined
  const names: string[] = []
  const disposers: (() => void)[] = []
  for (const spec of SPECS) {
    const installed = installOne(tools, agent, spec, record, logger)
    if (installed !== undefined) {
      names.push(installed.name)
      disposers.push(installed.dispose)
    }
  }
  let active = true
  const installation: RemoteToolInstallation = {
    names,
    record,
    dispose() {
      if (!active) return
      active = false
      for (const dispose of disposers.reverse()) {
        try { dispose() } catch (error) {
          logger?.warn(`ssh-workspace: failed to dispose a remote alias: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (installations.get(agent) === installation) installations.delete(agent)
    },
  }
  installations.set(agent, installation)
  return installation
}

/**
 * Install the remote-project prompt section on one agent.
 * @param agent - live or newly-created agent.
 * @param record - workspace attribution for host/path text.
 * @param names - installed remote_* names.
 * @param hideLocal - whether the corresponding local tools are hidden.
 * @param logger - optional warning sink.
 * @param localCwd - current local directory for ordinary tools; evaluated per assembly.
 * @returns the exact section disposer, or undefined when unavailable.
 */
export function installRemoteProjectPrompt(
  agent: RemoteToolAgent,
  record: RemoteWorkspaceRecord,
  names: readonly string[],
  hideLocal: boolean,
  logger?: RemoteToolsLogger,
  localCwd: () => string = () => '',
): (() => void) | undefined {
  const prompt = promptRegistry(agent)
  if (prompt === undefined) return undefined
  try {
    const dispose = prompt.section({
      name: REMOTE_PROJECT_SECTION,
      order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1,
      text: () => remotePrompt(record, names, hideLocal, localCwd),
      interpolate: false,
    })
    let active = true
    return () => {
      if (!active) return
      active = false
      try { dispose() } catch (error) {
        logger?.warn(`ssh-workspace: failed to dispose the remote project prompt: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } catch (error) {
    logger?.warn(`ssh-workspace: failed to install remote project prompt: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * Hide the local counterparts of installed aliases from one agent's model
 * catalog and execution. Preset tools register in the agent scope, which
 * `tools.restrict()` deliberately does not mask, so the shared registry's
 * public `get`/`schemas` views and the system-prompt assembly are filtered for
 * this agent instead. Local tools are restored when the returned disposer runs.
 * @param agent - agent whose local tools should disappear.
 * @param remoteNames - installed remote_* names.
 * @param logger - optional warning sink.
 * @returns the exact restoration disposer, or undefined when hiding is unavailable.
 */
export function hideLocalTools(
  agent: RemoteToolAgent,
  remoteNames: readonly string[],
  logger?: RemoteToolsLogger,
): (() => void) | undefined {
  const localNames = remoteNames
    .filter(name => name.startsWith('remote_'))
    .map(name => name.slice('remote_'.length))
  if (localNames.length === 0) return undefined
  const tools = registry(agent)
  if (tools === undefined) return undefined
  try {
    patchToolViews(tools)
  } catch (error) {
    logger?.warn(`ssh-workspace: failed to hide local tools: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  const previous = hiddenTools.get(agent)
  hiddenTools.set(agent, new Set(localNames))
  let disposeWaterfall: (() => void) | undefined
  try {
    const ctx = agent.ctx as unknown as {
      on(
        event: 'system-prompt/assemble',
        listener: (
          assembly: PromptAssemblyLike,
          context: unknown,
          next: () => Promise<PromptAssemblyLike>,
        ) => Promise<PromptAssemblyLike>,
      ): () => void
    }
    disposeWaterfall = ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const resolved = await next()
      const hidden = hiddenTools.get(agent)
      if (hidden === undefined || hidden.size === 0) return resolved
      const filtered = resolved.tools.filter(tool => !hidden.has(tool.name))
      return filtered.length === resolved.tools.length ? resolved : { ...resolved, tools: filtered }
    })
  } catch (error) {
    restoreHidden(agent, previous)
    logger?.warn(`ssh-workspace: failed to filter the system prompt: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  notifyToolsChanged(agent, logger)
  let active = true
  return () => {
    if (!active) return
    active = false
    try { disposeWaterfall?.() } catch (error) {
      logger?.warn(`ssh-workspace: failed to dispose the tool filter: ${error instanceof Error ? error.message : String(error)}`)
    }
    restoreHidden(agent, previous)
    notifyToolsChanged(agent, logger)
  }
}

function restoreHidden(agent: RemoteToolAgent, previous: ReadonlySet<string> | undefined): void {
  if (previous === undefined) hiddenTools.delete(agent)
  else hiddenTools.set(agent, previous)
}

function patchToolViews(tools: ToolRegistryLike): void {
  if (patchedViews.has(tools)) return
  const get = tools.get.bind(tools)
  const schemas = tools.schemas.bind(tools)
  tools.get = (name, scope) => {
    const hidden = hiddenFor(scope)
    return hidden !== undefined && hidden.has(name) ? undefined : get(name, scope)
  }
  tools.schemas = scope => {
    const all = schemas(scope)
    const hidden = hiddenFor(scope)
    return hidden === undefined ? all : all.filter(schema => !hidden.has(schema.name))
  }
  patchedViews.add(tools)
}

function hiddenFor(scope: unknown): ReadonlySet<string> | undefined {
  return typeof scope === 'object' && scope !== null ? hiddenTools.get(scope) : undefined
}

function notifyToolsChanged(agent: RemoteToolAgent, logger: RemoteToolsLogger | undefined): void {
  try {
    (agent.ctx as unknown as { emit(event: string): void }).emit('tools/change')
  } catch (error) {
    logger?.warn(`ssh-workspace: failed to notify tools/change: ${error instanceof Error ? error.message : String(error)}`)
  }
}
