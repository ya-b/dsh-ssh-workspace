/**
 * Agent-preset policy for remote tools. A preset id listed in the mount config
 * opts the session into `remote_*` aliases; `both` keeps the local tools beside
 * them, while `auto` hides the local counterparts in adopted remote workspaces
 * and leaves local workspaces untouched.
 * @module @dsh-ssh-workspace/mount/tool-presets
 */

import {
  hideLocalTools, installRemoteProjectPrompt, installRemoteTools,
  type RemoteToolAgent, type RemoteToolsLogger,
} from './remote-tools.ts'
import type { RemoteWorkspaceRecord, RemoteWorkspaceState } from './state.ts'

/** How a preset treats the local counterparts of remote tools. */
export type RemoteToolPresetMode = 'both' | 'auto'

/** One configured preset identity and its local-tool policy. */
export interface RemoteToolPreset {
  readonly id: string
  readonly mode?: RemoteToolPresetMode
}

/** Resolved policy for one live agent. */
export interface RemoteToolPolicy {
  readonly preset: RemoteToolPreset
  readonly mode: RemoteToolPresetMode
  readonly cwd: string
  readonly record: RemoteWorkspaceRecord
}

/** One agent's applied policy; dispose restores the previous tool surface. */
export interface RemoteToolBinding {
  readonly presetId: string
  readonly cwd: string
  dispose(): void
}

/** Verdict the client and the turn gate share for one remote session. */
export interface RemoteToolsGuard {
  readonly blocked: boolean
  readonly reason?: string
}

/** User-facing reason a remote workspace refuses turns without remote tools. */
export const REMOTE_TOOLS_REQUIRED_MESSAGE = '远程工作区需要 “SSH Workspace” 或 “SSH Workspace (Auto)” preset：当前 preset 没有 remote_* 工具，已禁止对话；若当前会话已开始且无法切换 preset，请新建会话。'

/**
 * Resolve the configured policy for a preset and workspace.
 * @param presets - configured preset list.
 * @param presetId - the agent's composed preset id.
 * @param cwd - the agent session cwd.
 * @param state - remote workspace attribution sidecar.
 * @returns the policy, or undefined for local/unconfigured presets.
 */
export function resolveRemoteToolPolicy(
  presets: readonly RemoteToolPreset[],
  presetId: string | undefined,
  cwd: string,
  state: Pick<RemoteWorkspaceState, 'covering'>,
): RemoteToolPolicy | undefined {
  if (presetId === undefined || cwd === '') return undefined
  const preset = presets.find(candidate => candidate.id === presetId)
  if (preset === undefined) return undefined
  const record = state.covering(cwd)
  if (record === undefined) return undefined
  return { preset, mode: preset.mode ?? 'both', cwd, record }
}

/**
 * Whether a remote workspace must refuse a turn because the selected preset
 * does not enable remote tools. Local workspaces are never gated.
 * @param presets - configured preset list.
 * @param presetId - the agent's composed preset id.
 * @param cwd - the agent session cwd.
 * @param state - remote workspace attribution sidecar.
 * @returns true when the cwd is remote and the preset has no remote-tool policy.
 */
export function remoteToolsRequired(
  presets: readonly RemoteToolPreset[],
  presetId: string | undefined,
  cwd: string,
  state: Pick<RemoteWorkspaceState, 'covering'>,
): boolean {
  if (cwd === '' || state.covering(cwd) === undefined) return false
  return resolveRemoteToolPolicy(presets, presetId, cwd, state) === undefined
}

/**
 * Install aliases, the prompt, and (in `auto` mode) the local-tool filter.
 * A failed hide degrades to `both` behavior rather than hiding tools without a
 * remote replacement.
 * @param agent - target agent.
 * @param state - remote workspace attribution sidecar.
 * @param policy - resolved preset policy.
 * @param logger - optional warning sink.
 * @param localCwd - current local directory for ordinary tools; evaluated per assembly.
 * @returns the applied binding, or undefined when installation was impossible.
 */
export function applyRemoteToolPolicy(
  agent: RemoteToolAgent,
  state: Pick<RemoteWorkspaceState, 'covering'>,
  policy: RemoteToolPolicy,
  logger?: RemoteToolsLogger,
  localCwd?: () => string,
): RemoteToolBinding | undefined {
  const installation = installRemoteTools(agent, state, logger)
  if (installation === undefined) return undefined
  const restore = policy.mode === 'auto'
    ? hideLocalTools(agent, installation.names, logger)
    : undefined
  const prompt = installRemoteProjectPrompt(
    agent,
    installation.record,
    installation.names,
    restore !== undefined,
    logger,
    localCwd,
  )
  let active = true
  return {
    presetId: policy.preset.id,
    cwd: policy.cwd,
    dispose() {
      if (!active) return
      active = false
      disposeStep(prompt, 'remote project prompt', logger)
      disposeStep(restore, 'local tool filter', logger)
      try { installation.dispose() } catch (error) {
        logger?.warn(`ssh-workspace: failed to dispose remote tools: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

function disposeStep(step: (() => void) | undefined, label: string, logger: RemoteToolsLogger | undefined): void {
  if (step === undefined) return
  try { step() } catch (error) {
    logger?.warn(`ssh-workspace: failed to dispose ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
