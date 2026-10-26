/**
 * 0.2.1-native remote workspace mounting. The plugin owns four pieces:
 *
 * - a per-host runtime pool of daemon-backed `ctx.ssh` plus the official SSH
 *   provider family (`ssh`, `fs`, `subprocess`, `sandbox` — all upstream code),
 * - root-plane routers that keep the official local providers as fallback and
 *   dispatch each path-, cwd-, or policy-rooted call to the owning machine,
 * - workspace adoption on the official registry: a durable record whose path
 *   is the canonical *remote* directory, with a strict sidecar mapping the
 *   workspace id back to its host,
 * - agent-scoped `remote_*` aliases of the official fs/bash tools plus a
 *   remote-project prompt section, with execute-time workspace path gates.
 *
 * Nothing in the harness is modified; every seam is a runtime patch of an
 * official instance, and the daemon's public surface is exactly what the
 * published SSH providers expect.
 * @module @dsh-ssh-workspace/mount
 */

import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { isAbsolute, join, posix } from 'node:path'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-workspace'
import { RemoteHosts } from './hosts.ts'
import { createLocalCwdStore, patchLocalSandboxPolicy, patchLocalWorkingDirectory, type LocalCwdStore } from './local-execution.ts'
import { patchFileSystem, patchSandbox, patchSessionController, patchSubprocess, patchTerminalController } from './patch.ts'
import { adoptRemoteWorkspace, patchRegistry, type RegistryLike } from './registry.ts'
import { type RemoteToolAgent } from './remote-tools.ts'
import {
  applyRemoteToolPolicy, remoteToolsRequired, resolveRemoteToolPolicy,
  REMOTE_TOOLS_REQUIRED_MESSAGE,
  type RemoteToolBinding, type RemoteToolPreset, type RemoteToolsGuard,
} from './tool-presets.ts'
import { RemoteWorkspaceState, type RemoteWorkspaceRecord } from './state.ts'
import { isHostToolName, runToolScope } from './tool-scope.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sshWorkspace: SshWorkspaceMount
  }
}

/** Deployment settings of the mount. */
export interface Config {
  /** Remote daemon state directory; `~/` is expanded by the remote shell. */
  daemonDir?: string
  /** Absolute remote Node executable used to run the daemon. */
  node?: string
  /** Per-request administrative deadline, in milliseconds. */
  requestTimeoutMs?: number
  /** Extra attempts after the deadline on replayable operations. */
  requestTimeoutRetries?: number
  /** First delay before a deadline retry, doubling per attempt. */
  requestTimeoutRetryBaseMs?: number
  /** Reconnect backoff base, in milliseconds. */
  reconnectBaseMs?: number
  /** Reconnect backoff ceiling in milliseconds. */
  reconnectMaxMs?: number
  /**
   * Absolute local working directory ordinary tools use inside a remote
   * workspace. The workspace UI and terminal stay on the remote host.
   */
  localCwd?: string
  /** Local SSH control directory; a temp directory when absent. */
  controlDir?: string
  /** Install the shipped daemon archive on first use of a host. */
  install?: boolean
  /**
   * Replace a remote daemon whose loaded bundle no longer matches the installed
   * one. Only an idle daemon (no live child processes) is replaced, so running
   * commands are never interrupted.
   */
  autoUpgrade?: boolean
  /** Override the shipped daemon archive path, for development. */
  daemonArchive?: string
  /** Attribution sidecar path; defaults under the harness home's storages. */
  statePath?: string
  /**
   * Agent presets that enable remote_* tools. `both` keeps the local tools;
   * `auto` hides their local counterparts in adopted remote workspaces.
   */
  toolPresets?: RemoteToolPreset[]
}

type ResolvedConfig = {
  daemonDir: string
  node: string
  requestTimeoutMs: number
  requestTimeoutRetries: number
  requestTimeoutRetryBaseMs: number
  reconnectBaseMs: number
  reconnectMaxMs: number
  localCwd: string
  controlDir?: string
  install: boolean
  autoUpgrade: boolean
  daemonArchive?: string
  maxFrameBytes?: number
  maxPending?: number
  statePath?: string
  toolPresets: readonly RemoteToolPreset[]
}

/** One directory child returned to the picker. */
export interface BrowseEntry {
  name: string
  path: string
  hidden: boolean
}

/** One directory level returned to the picker. */
export interface BrowseListing {
  /** Canonical spelling of the listed directory. */
  path: string
  /** Parent directory, absent at a filesystem root. */
  parent?: string
  entries: BrowseEntry[]
}

/** View of one adopted remote workspace. */
export interface AdoptedWorkspace {
  workspaceId: string
  host: string
  path: string
  title: string
}

/** Default attribution sidecar under the harness home. */
function defaultStatePath(): string {
  const home = process.env.DSH_HOME === undefined || process.env.DSH_HOME === '' ? join(homedir(), '.dsh') : process.env.DSH_HOME
  return join(home, 'storages', 'ssh-workspaces.json')
}

/** The `tools/execute` fields the scope router reads. */
interface ToolExecutionLike {
  readonly name: string
  readonly agent?: { readonly session?: { readonly header?: { readonly cwd?: string } } } | undefined
}

/** The `agent/pre-step` fields the turn gate reads. */
interface PreStepLike {
  readonly agent: RemoteToolAgent
  readonly messages: readonly unknown[]
}

/**
 * The plugin service. Loads as `ctx.sshWorkspace`; its `adopt`/`browse`
 * methods are what the HTTP picker half consumes.
 */
export class SshWorkspaceMount extends Service {
  static Config = schema.object({
    daemonDir: schema.string().default('~/.dsh-workspace'),
    node: schema.string().default('node'),
    requestTimeoutMs: schema.number().min(1).max(2_147_483_647).default(30_000),
    requestTimeoutRetries: schema.number().min(0).max(20).default(5),
    requestTimeoutRetryBaseMs: schema.number().min(10).max(2_147_483_647).default(10_000),
    reconnectBaseMs: schema.number().min(10).max(60_000).default(250),
    reconnectMaxMs: schema.number().min(100).max(600_000).default(15_000),
    localCwd: schema.string().default('/tmp'),
    controlDir: schema.string(),
    install: schema.boolean().default(true),
    autoUpgrade: schema.boolean().default(true),
    daemonArchive: schema.string(),
    maxFrameBytes: schema.number(),
    maxPending: schema.number(),
    statePath: schema.string(),
    toolPresets: schema.array(schema.object({
      id: schema.string().required(),
      mode: schema.union(['both', 'auto'] as const).default('both'),
    })).default([]),
  })

  static inject = ['fs', 'subprocess', 'sandbox', 'workspaceRegistry']

  private readonly hosts: RemoteHosts
  private readonly state: RemoteWorkspaceState
  private readonly toolPresets: readonly RemoteToolPreset[]
  private readonly localCwdStore: LocalCwdStore
  private readonly remoteBindings = new WeakMap<RemoteToolAgent, RemoteToolBinding>()
  private readonly liveBindings = new Set<RemoteToolBinding>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sshWorkspace')
    const resolved = SshWorkspaceMount.Config({
      daemonDir: '~/.dsh-workspace', node: 'node', requestTimeoutMs: 30_000,
      requestTimeoutRetries: 5, requestTimeoutRetryBaseMs: 10_000, reconnectBaseMs: 250, reconnectMaxMs: 15_000,
      localCwd: '/tmp', install: true, autoUpgrade: true, toolPresets: [], ...config,
    }) as unknown as ResolvedConfig
    if (!isAbsolute(resolved.localCwd)) throw new Error(`ssh-workspace: localCwd must be absolute, got ${JSON.stringify(resolved.localCwd)}`)
    this.toolPresets = resolved.toolPresets
    this.localCwdStore = createLocalCwdStore(resolved.localCwd)
    this.state = new RemoteWorkspaceState(resolved.statePath === undefined || resolved.statePath === '' ? defaultStatePath() : resolved.statePath)
    this.hosts = new RemoteHosts(ctx, {
      daemonDir: resolved.daemonDir,
      node: resolved.node,
      requestTimeoutMs: resolved.requestTimeoutMs,
      requestTimeoutRetries: resolved.requestTimeoutRetries,
      requestTimeoutRetryBaseMs: resolved.requestTimeoutRetryBaseMs,
      reconnectBaseMs: resolved.reconnectBaseMs,
      reconnectMaxMs: resolved.reconnectMaxMs,
      install: resolved.install,
      autoUpgrade: resolved.autoUpgrade,
      ...(resolved.controlDir === undefined ? {} : { controlDir: resolved.controlDir }),
      ...(resolved.daemonArchive === undefined ? {} : { daemonArchive: resolved.daemonArchive }),
      ...(resolved.maxFrameBytes === undefined ? {} : { maxFrameBytes: resolved.maxFrameBytes }),
      ...(resolved.maxPending === undefined ? {} : { maxPending: resolved.maxPending }),
    })
  }

  /** Wire the routers, then reconnect every host a previous run adopted. */
  protected async [Service.init](): Promise<void> {
    await this.state.list()
    patchFileSystem(this.ctx, this.ctx.fs, this.hosts, this.state)
    patchSubprocess(this.ctx, this.ctx.subprocess, this.hosts, this.state)
    patchSandbox(this.ctx.sandbox, this.hosts, this.state)
    const onToolExecute = this.ctx.on as unknown as (
      event: 'tools/execute',
      listener: (exec: ToolExecutionLike, next: () => Promise<unknown>) => Promise<unknown>,
    ) => () => void
    onToolExecute.call(this.ctx, 'tools/execute', async (exec, next) => {
      const cwd = exec.agent?.session?.header?.cwd
      const record = cwd === undefined ? undefined : this.state.covering(cwd)
      return await runToolScope(
        record === undefined || !isHostToolName(exec.name)
          ? { kind: 'local' }
          : { kind: 'remote', record },
        next,
      )
    })
    const onPreStep = this.ctx.on as unknown as (
      event: 'agent/pre-step',
      listener: (payload: PreStepLike, next: () => Promise<unknown>) => Promise<unknown>,
    ) => () => void
    onPreStep.call(this.ctx, 'agent/pre-step', async (payload, next) => {
      if (payload.messages.length === 0 || !this.missingRemoteTools(payload.agent)) return await next()
      throw new Error(REMOTE_TOOLS_REQUIRED_MESSAGE)
    })
    this.ctx.inject(['workingDirectory'], (directoryCtx) => {
      patchLocalWorkingDirectory(
        (directoryCtx as unknown as { workingDirectory: Parameters<typeof patchLocalWorkingDirectory>[0] }).workingDirectory,
        this.state,
        this.localCwdStore,
        () => this.ctx.fs,
      )
    })
    this.ctx.inject(['sandboxPolicy'], (policyCtx) => {
      patchLocalSandboxPolicy(
        (policyCtx as unknown as { sandboxPolicy: Parameters<typeof patchLocalSandboxPolicy>[0] }).sandboxPolicy,
        this.state,
        this.localCwdStore,
      )
    })
    patchRegistry(this.ctx, this.ctx.workspaceRegistry as unknown as RegistryLike, this.state)
    this.ctx.inject(['terminalController'], (termCtx) => {
      patchTerminalController((termCtx as unknown as { terminalController: { execution(agent: { session?: { header?: { cwd?: string } } }): object } }).terminalController, this.hosts, this.state)
    })
    this.ctx.inject(['sessionController'], (sessionCtx) => {
      patchSessionController((sessionCtx as unknown as { sessionController: Parameters<typeof patchSessionController>[0] }).sessionController, this.hosts, this.state)
    })
    this.ctx.inject(['agents'], (agentCtx) => {
      const agents = agentCtx as unknown as {
        agents: {
          list(): readonly RemoteToolAgent[]
          get(id: string): RemoteToolAgent | undefined
        }
      }
      const onAgentLifecycle = this.ctx.on as unknown as (
        event: 'agent/created' | 'agent/disposed',
        listener: (payload: { agent: RemoteToolAgent }) => void,
      ) => () => void
      onAgentLifecycle.call(this.ctx, 'agent/created', payload => { this.applyRemoteTools(payload.agent) })
      onAgentLifecycle.call(this.ctx, 'agent/disposed', payload => { this.removeAgentBindings(payload.agent) })
      const onPresetSelected = this.ctx.on as unknown as (
        event: 'agent-preset/selected',
        listener: (sessionId: string) => void,
      ) => () => void
      onPresetSelected.call(this.ctx, 'agent-preset/selected', sessionId => {
        const agent = agents.agents.get(sessionId)
        if (agent !== undefined) this.applyRemoteTools(agent)
      })
      for (const agent of agents.agents.list()) this.applyRemoteTools(agent)
    })
    this.ctx.effect(() => () => {
      for (const binding of [...this.liveBindings]) {
        this.liveBindings.delete(binding)
        binding.dispose()
      }
    }, 'ssh-workspace: agent tool bindings')
    this.ctx.effect(() => () => { void this.hosts.dispose() }, 'ssh-workspace: host transports')
    const hosts = new Set(this.state.snapshot().map(record => record.host))
    for (const host of hosts) {
      this.hosts.pair(host).ready.catch((error: unknown) => {
        this.ctx.logger.warn(`ssh-workspace: host '${host}' is not reachable yet: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }

  private composedPreset(agent: RemoteToolAgent): string | undefined {
    const presets = this.ctx.get('agentPresets') as { composedPreset(ctx: Context): string | undefined } | undefined
    return presets?.composedPreset(agent.ctx)
  }

  private applyRemoteTools(agent: RemoteToolAgent): void {
    try {
      const presetId = this.composedPreset(agent)
      const cwd = agent.session.header?.cwd
      if (presetId === undefined || cwd === undefined || cwd === '') {
        this.removeAgentBindings(agent)
        return
      }
      const policy = resolveRemoteToolPolicy(this.toolPresets, presetId, cwd, this.state)
      if (policy === undefined) {
        this.removeRemoteTools(agent)
        return
      }
      const existing = this.remoteBindings.get(agent)
      if (existing !== undefined && existing.presetId === policy.preset.id && existing.cwd === policy.cwd) return
      this.removeRemoteTools(agent)
      const binding = applyRemoteToolPolicy(
        agent,
        this.state,
        policy,
        this.ctx.logger,
        () => this.localCwdStore.of(agent.session),
      )
      if (binding === undefined) return
      this.remoteBindings.set(agent, binding)
      this.liveBindings.add(binding)
    } catch (error) {
      this.ctx.logger.warn(`ssh-workspace: failed to apply remote tools: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private removeRemoteTools(agent: RemoteToolAgent): void {
    const binding = this.remoteBindings.get(agent)
    if (binding === undefined) return
    this.remoteBindings.delete(agent)
    this.liveBindings.delete(binding)
    binding.dispose()
  }

  private removeAgentBindings(agent: RemoteToolAgent): void {
    this.removeRemoteTools(agent)
  }

  /**
   * Whether a remote-workspace agent cannot answer: its preset has no
   * remote-tool policy, or the aliases failed to install.
   * @param agent - agent about to receive a turn.
   */
  private missingRemoteTools(agent: RemoteToolAgent): boolean {
    const cwd = agent.session.header?.cwd
    if (cwd === undefined || cwd === '') return false
    if (this.state.covering(cwd) === undefined) return false
    const policy = resolveRemoteToolPolicy(this.toolPresets, this.composedPreset(agent), cwd, this.state)
    return policy === undefined || this.remoteBindings.get(agent) === undefined
  }

  /**
   * Adopt one remote directory as a workspace on its host.
   * @param input - host alias, remote directory, and optional initial title.
   * @returns the adopted workspace view.
   */
  async adopt(input: { host: string, path: string, title?: string }): Promise<AdoptedWorkspace> {
    const entity = await adoptRemoteWorkspace(this.ctx.workspaceRegistry as unknown as RegistryLike, this.hosts, this.state, input)
    return { workspaceId: String(entity.id), host: input.host, path: entity.path, title: entity.title }
  }

  /**
   * List one directory level on one machine: the local harness machine for
   * `null`, the owning daemon-backed provider for an alias.
   * @param host - OpenSSH alias, or null/empty for the harness machine.
   * @param path - absolute directory path in the target machine's namespace.
   */
  async browse(host: string | null, path: string): Promise<BrowseListing> {
    const remote = host !== null && host !== ''
    const runtime = remote ? this.hosts.pair(host) : undefined
    if (runtime !== undefined) await runtime.ready
    const fs = runtime?.fs ?? this.ctx.fs
    if (!isAbsolute(path)) throw new Error(`browse needs an absolute path, got ${JSON.stringify(path)}`)
    const resolved = await fs.resolve(path)
    const info = await fs.stat(resolved)
    const machine = remote ? host : 'this machine'
    if (info?.type !== 'directory') throw new Error(`${JSON.stringify(path)} is not a directory on ${machine}`)
    const canonical = fs.processPath(resolved)
    const entries = await fs.listDir(resolved)
    const parent = posix.dirname(canonical)
    return {
      path: canonical,
      ...(parent === canonical ? {} : { parent }),
      entries: entries
        .filter(entry => entry.type === 'directory')
        .map(entry => ({ name: entry.name, path: fs.processPath(entry.target), hidden: entry.name.startsWith('.') }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    }
  }

  /** Every adopted remote workspace. */
  records(): readonly RemoteWorkspaceRecord[] {
    return this.state.snapshot()
  }

  /** The host alias owning one workspace id, when it is a remote workspace. */
  hostOfWorkspace(workspaceId: string): string | undefined {
    return this.state.byWorkspace(workspaceId)?.host
  }

  /**
   * Whether one session location may converse under the selected preset.
   * Remote workspaces require a preset configured with remote tools; local
   * workspaces are never gated.
   * @param cwd - session cwd (the remote path for adopted workspaces).
   * @param presetId - active agent-preset id.
   * @returns the client-visible verdict and its reason.
   */
  guard(cwd: string | undefined, presetId: string | undefined): RemoteToolsGuard {
    if (cwd === undefined || cwd === '') return { blocked: false }
    if (!remoteToolsRequired(this.toolPresets, presetId, cwd, this.state)) return { blocked: false }
    return { blocked: true, reason: REMOTE_TOOLS_REQUIRED_MESSAGE }
  }
}

export default SshWorkspaceMount
