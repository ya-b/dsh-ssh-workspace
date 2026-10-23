/**
 * Remote-facing aliases of the official file and bash tools. Adopted remote
 * workspaces live in the official registry with a *remote* cwd, but the stock
 * model still has no way to choose between that machine and the harness
 * machine. These aliases make the choice explicit while delegating every
 * execution detail (schemas, approvals, output rendering, timeouts) to the
 * official definitions.
 *
 * Aliases are registered into the agent scope, so a remote subagent gets the
 * same pair of surfaces as its parent while local sessions see nothing. Paths
 * are checked against the workspace record at execution time and rewritten to
 * absolute remote spellings before the original tool runs.
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

interface ToolRegistryLike {
  get(name: string, scope?: unknown): RemoteToolDefinition | undefined
  register(definition: RemoteToolDefinition): () => void
}

interface SystemPromptLike {
  section(section: {
    readonly name: string
    readonly order: number
    readonly text: string
    readonly interpolate?: boolean
  }): () => void
  getSectionOrder(name: string): number
}

interface WorkingDirectoryLike {
  ensure(agent: unknown, signal?: AbortSignal): Promise<string>
}

interface RemoteToolsLogger {
  warn(message: string): void
}

type SourceTool = 'read' | 'write' | 'edit' | 'read_image' | 'bash'

interface RemoteToolSpec {
  readonly source: SourceTool
  readonly field: 'file_path' | 'workdir'
}

const SPECS: readonly RemoteToolSpec[] = [
  { source: 'read', field: 'file_path' },
  { source: 'write', field: 'file_path' },
  { source: 'edit', field: 'file_path' },
  { source: 'read_image', field: 'file_path' },
  { source: 'bash', field: 'workdir' },
]

const installed = new WeakSet<object>()

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

function remotePrompt(record: RemoteWorkspaceRecord, tools: readonly string[]): string {
  const available = tools.length === 0
    ? 'No remote-specific tools are available in this session.'
    : `Prefer ${tools.map(name => `\`${name}\``).join(', ')} for files and commands in this project. They are bound to the host and accept only paths inside the workspace; relative paths resolve from the current remote directory.`
  return [
    `This project is a remote project: its workspace is ${JSON.stringify(record.path)} on SSH host ${JSON.stringify(record.host)}.`,
    'Its files, commands, and terminals run on that machine, not on the harness machine.',
    available,
    'The original tools remain available and follow the workspace routing for paths inside it, but only the remote tools enforce the workspace boundary; prefer remote_* for project work.',
  ].join('\n\n')
}

function registry(agent: RemoteToolAgent): ToolRegistryLike | undefined {
  const tools = agent.ctx.get('tools') as ToolRegistryLike | undefined
  return tools !== undefined && typeof tools.get === 'function' && typeof tools.register === 'function' ? tools : undefined
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
): string | undefined {
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
    tools.register(definition)
    return name
  } catch (error) {
    logger?.warn(`ssh-workspace: failed to register ${name}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * Install remote_* aliases and the remote-project prompt section on one agent.
 * The agent must already carry a remote cwd and a workspace record; local
 * agents are a no-op. Registration is idempotent per agent.
 * @param agent - live or newly-created agent.
 * @param state - remote workspace sidecar used for host/path attribution.
 * @param logger - optional warning sink for non-fatal registration failures.
 * @returns model-facing names that were installed by this call.
 */
export function installRemoteTools(
  agent: RemoteToolAgent,
  state: Pick<RemoteWorkspaceState, 'covering'>,
  logger?: RemoteToolsLogger,
): readonly string[] {
  if (installed.has(agent)) return []
  const cwd = agent.session.header?.cwd
  if (cwd === undefined || cwd === '') return []
  const record = state.covering(cwd)
  if (record === undefined) return []
  const tools = registry(agent)
  if (tools === undefined) return []
  const names: string[] = []
  for (const spec of SPECS) {
    const name = installOne(tools, agent, spec, record, logger)
    if (name !== undefined) names.push(name)
  }
  const prompt = promptRegistry(agent)
  if (prompt !== undefined) {
    try {
      prompt.section({
        name: REMOTE_PROJECT_SECTION,
        order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1,
        text: remotePrompt(record, names),
        interpolate: false,
      })
    } catch (error) {
      logger?.warn(`ssh-workspace: failed to install remote project prompt: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  installed.add(agent)
  return names
}
