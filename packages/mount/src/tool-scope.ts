/**
 * Per-tool-call execution scope. The root routers otherwise answer every call
 * in a remote workspace from the remote host; ordinary tools must stay on the
 * harness machine while the `remote_*` aliases and the terminal tools stay on
 * the host. `tools/execute` wraps dispatch in this scope, so the same `ctx.fs`
 * and `ctx.subprocess` singletons can serve both planes without reimplementing
 * the official tools.
 * @module @dsh-ssh-workspace/mount/tool-scope
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { RemoteWorkspaceRecord } from './state.ts'

/** The machine one tool dispatch must execute on. */
export type ToolExecutionScope =
  | { readonly kind: 'local' }
  | { readonly kind: 'remote', readonly record: RemoteWorkspaceRecord }

const storage = new AsyncLocalStorage<ToolExecutionScope>()

/** The scope of the currently executing tool, if the call came through `tools/execute`. */
export function currentToolScope(): ToolExecutionScope | undefined {
  return storage.getStore()
}

/** Whether the current dispatch must stay on the harness machine. */
export function isLocalToolScope(): boolean {
  return storage.getStore()?.kind === 'local'
}

/** Run one dispatch under an explicit scope, including every nested tool call. */
export function runToolScope<T>(scope: ToolExecutionScope, run: () => Promise<T>): Promise<T> {
  return storage.run(scope, run)
}

const HOST_TOOL_PREFIXES = ['remote_', 'terminal_', 'pty_'] as const

/**
 * Tools that keep the session host even though they are not `remote_*` aliases.
 * Terminal tools own PTY state on the host, so their `workingDirectory` and
 * subprocess lookups must not be redirected by the local-tool scope.
 */
export function isHostToolName(name: string): boolean {
  return HOST_TOOL_PREFIXES.some(prefix => name.startsWith(prefix))
}
