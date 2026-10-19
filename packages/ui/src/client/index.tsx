/**
 * Browser half of the remote-workspace UI — the directory-flow dialog.
 *
 * This plugin shadows the shipped browse occupant of the two directory-flow
 * holes (`conversation.hero.workspace.directoryFlow` and
 * `sidebar.workspaces.directoryFlow`) with its own copy of the harness's
 * "Select Workspace Directory" dialog (same Modal/Button primitives, same
 * title, breadcrumb path, directory list, hidden-file toggle, cancel/open
 * footer) extended with the one feature the plan requires: **a host selector
 * at the very top of the dialog**. 本机 + every `~/.ssh/config` alias; after a
 * host is chosen its directory tree is listed (本机 via the host plane, 远端
 * via the plugin's daemon connection). Nothing in the harness is modified: the
 * shadow is a lower `priority` registration, and all data comes from this
 * plugin's own host routes.
 *
 * 打开语义（场景 A：本机）= 由所属 owner 走既有 `onPicked(path)` →
 * `createWorkspace({path})`（本地工作区，随后自动开始会话）。
 * 打开语义（场景 B：远端）= 本弹窗调用 Host 的 `/ssh-workspace/adopt`，
 * 由挂载插件把远端目录登记成工作区（记录里存远端规范路径，宿主侧映射到
 * 主机），随后关闭弹窗 —— owner 的 `onPicked` 只会按本地语义创建工作区，
 * 不能承载 host。
 *
 * @module @dsh-ssh-workspace/ui/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: pulls the SlotMap declaration (the two directory-flow holes) and
// the ctx.slots service merge these registrations read.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'

/** Route prefix of this plugin's host half. */
const API = '/ssh-workspace'

/** Dial data of one machine (host half spelling). */
interface Machine {
  alias: string | null
  label: string
  local: boolean
  user?: string
  hostname?: string
  port?: number
}

/** Connectivity verdict of one machine. */
interface Precheck {
  alias: string
  status: 'usable' | 'needs-credentials' | 'unreachable' | 'unknown'
  detail: string
}

/** One directory level on one machine. */
interface Listing {
  path: string
  parent?: string
  entries: { name: string; path: string; hidden: boolean }[]
}

/** The slice of the Host Controller this dialog uses. */
interface WorkspaceRenamer {
  rename(workspaceId: string, title: string): Promise<unknown>
}

/**
 * The Host's own default title for a path (final segment, or the root), so a
 * rename added here only ever replaces an untouched default — a title the
 * user already customized is left alone.
 * @param path - canonical absolute path.
 */
function defaultTitleOf(path: string): string {
  const trimmed = path.replace(/\/+$/u, '')
  if (trimmed === '') return '/'
  const cut = trimmed.lastIndexOf('/')
  return cut === -1 ? trimmed : trimmed.slice(cut + 1) || '/'
}

/** How long one host route may take before the dialog reports the failure. */
const CALL_TIMEOUT_MS = 15_000

/**
 * The harness Modal card is `min(380px, 100%)`; this dialog carries a host
 * selector plus a monospace path and needs more. The doubled class beats the
 * Modal's own `.dialog` rule regardless of stylesheet order (same trick the
 * shipped directory browser uses), and the rule is injected at activation
 * because this bundle has no CSS pipeline.
 */
const DIALOG_CLASS = 'dsh-ssh-workspace-dialog'
const DIALOG_CSS = `.${DIALOG_CLASS}.${DIALOG_CLASS}{width:min(720px,100%)}`

/** Call one host route and unwrap its JSON body or its error message. */
async function call<T>(route: string, query: Record<string, string> = {}, body?: unknown): Promise<T> {
  const url = new URL(`${API}${route}`, window.location.origin)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  const response = await fetch(url, {
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  })
  const responseBody = await response.json().catch(() => undefined) as (T & { error?: string }) | undefined
  if (!response.ok) throw new Error(responseBody?.error ?? `${String(response.status)} ${response.statusText}`)
  return responseBody as T
}

/** Machine list, fetched once per page session. */
let machinesOnce: Promise<Machine[]> | undefined
function loadMachines(): Promise<Machine[]> {
  machinesOnce ??= call<{ machines: Machine[] }>('/machines').then(result => result.machines).catch((error: unknown) => {
    machinesOnce = undefined
    throw error
  })
  return machinesOnce
}

/** Prechecks are cached per alias: a machine's verdict does not move by the second. */
const prechecks = new Map<string, Promise<Precheck>>()
function precheckOf(alias: string): Promise<Precheck> {
  let pending = prechecks.get(alias)
  if (pending === undefined) {
    pending = call<Precheck>('/precheck', { host: alias }).catch((error: unknown) => {
      prechecks.delete(alias)
      throw error
    })
    prechecks.set(alias, pending)
  }
  return pending
}

/** Directory listings are cached per host and path for the page session. */
const listings = new Map<string, Promise<Listing>>()
function listingOf(host: string | undefined, path: string): Promise<Listing> {
  const key = `${host ?? 'local'}\u0000${path}`
  let pending = listings.get(key)
  if (pending === undefined) {
    pending = call<Listing>('/browse', { path, ...(host === undefined ? {} : { host }) }).catch((error: unknown) => {
      listings.delete(key)
      throw error
    })
    listings.set(key, pending)
  }
  return pending
}

/**
 * The dialog. Owns the whole interaction: machine list, connectivity verdict,
 * directory tree, and the create-vs-pick decision described at the top.
 * @param props - the owner conversation the holder of the flow hole gives us.
 * @returns the dialog element (null while closed).
 */
/** The owner conversation plus the plugin context the remote create call reads. */
export type RemoteDirectoryBrowserProps = DirectoryFlowOwnerProps & { ctx: Context }

export function RemoteDirectoryBrowser(props: RemoteDirectoryBrowserProps): ReactElement {
  const [machines, setMachines] = useState<Machine[] | undefined>(undefined)
  const [host, setHost] = useState<Machine | undefined>(undefined)
  const [precheck, setPrecheck] = useState<Precheck | undefined>(undefined)
  const [checking, setChecking] = useState(false)
  const [listing, setListing] = useState<Listing | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [creating, setCreating] = useState(false)

  // Reset per open; the machine list is loaded once per page session.
  useEffect(() => {
    if (!props.open) return
    setHost(undefined)
    setPrecheck(undefined)
    setListing(undefined)
    setError(undefined)
    setCreating(false)
    loadMachines()
      .then(result => { setMachines(result) })
      .catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) })
  }, [props.open])

  const browse = useCallback(async (machine: Machine, path: string): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      setListing(await listingOf(machine.alias ?? undefined, path))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [])

  const selectHost = useCallback(async (machine: Machine): Promise<void> => {
    setHost(machine)
    setPrecheck(undefined)
    setListing(undefined)
    setError(undefined)
    if (machine.local) {
      await browse(machine, '')
      return
    }
    setChecking(true)
    try {
      setPrecheck(await precheckOf(machine.alias ?? ''))
      await browse(machine, '')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setChecking(false)
    }
  }, [browse])

  // First open: default to the local machine, then to the first alias.
  useEffect(() => {
    if (!props.open || host !== undefined || machines === undefined || machines.length === 0) return
    void selectHost(machines[0] as Machine)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, host, machines])

  const openPicked = useCallback(async (): Promise<void> => {
    if (listing === undefined || host === undefined) return
    if (host.local) {
      // Local: hand the path to the owner — it creates the local workspace and
      // starts the session, exactly as the shipped dialog does.
      props.onPicked(listing.path)
      return
    }
    // Remote: the owner's onPicked cannot carry a host, so the dialog asks the
    // mount plugin to adopt the directory on its machine and closes; the new
    // row appears in the sidebar. The Host titles a fresh workspace after the
    // directory alone, which is ambiguous across machines: a remote row is
    // retitled `<folder>@<host>` unless the caller already renamed it.
    setCreating(true)
    setError(undefined)
    try {
      const alias = host.alias as string
      const created = await call<{ workspaceId: string, title: string }>('/adopt', {}, { host: alias, path: listing.path })
      if (created.title === defaultTitleOf(listing.path)) {
        const workspaces = props.ctx.get('workspaces') as unknown as WorkspaceRenamer
        await workspaces.rename(created.workspaceId, `${defaultTitleOf(listing.path)}@${alias}`)
      }
      props.onCancel()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCreating(false)
    }
  }, [host, listing, props])

  const visible = listing?.entries.filter(entry => showHidden || !entry.hidden) ?? []
  const status = host === undefined
    ? undefined
    : host.local
      ? { text: '本机', tone: 'ok' as const }
      : checking
        ? { text: '检测中…', tone: 'busy' as const }
        : precheck === undefined
          ? undefined
          : { text: `${precheck.status}：${precheck.detail}`, tone: (precheck.status === 'usable' ? 'ok' : precheck.status === 'needs-credentials' ? 'warn' : 'bad') as 'ok' | 'warn' | 'bad' }

  return (
    <Modal
      open={props.open}
      onClose={() => { if (!busy && !creating) props.onCancel() }}
      title="选择工作区目录"
      closeLabel="关闭"
      className={DIALOG_CLASS}
      footer={(
        <>
          <Button variant="outline" onClick={() => { if (!busy && !creating) props.onCancel() }}>取消</Button>
          <Button variant="primary" disabled={busy || creating || listing === undefined} onClick={() => { void openPicked() }}>
            {creating ? '正在添加…' : '打开'}
          </Button>
        </>
      )}
    >
      <div style={PANEL_STYLE}>
        {/* ── 弹窗最上方：主机选择 ───────────────────────────── */}
        <div style={HOST_ROW_STYLE}>
          <label style={LABEL_STYLE} htmlFor="ssh-workspace-host">主机</label>
          <select
            id="ssh-workspace-host"
            style={SELECT_STYLE}
            disabled={busy}
            value={host?.alias ?? ''}
            onChange={(event) => {
              const selected = machines?.find(machine => (machine.alias ?? '') === event.target.value)
              if (selected !== undefined) void selectHost(selected)
            }}
          >
            {machines === undefined
              ? <option value="">{error === undefined ? '读取 ~/.ssh/config…' : '读取 ~/.ssh/config 失败'}</option>
              : machines.map(machine => (
                <option key={machine.alias ?? 'local'} value={machine.alias ?? ''}>
                  {machine.local ? `${machine.label}（本机）` : machine.label}
                </option>
              ))}
          </select>
          {status === undefined ? null : <span style={{ ...STATUS_STYLE, color: TONE_COLOR[status.tone] }}>{status.text}</span>}
        </div>

        {/* 当前目录 */}
        <div style={PATH_ROW_STYLE}>
          <span style={PATH_STYLE}>{listing?.path ?? (busy ? '加载中…' : '请选择主机')}</span>
          <Button variant="toolbar" size="sm" disabled={busy || listing?.parent === undefined} onClick={() => { if (host !== undefined && listing?.parent !== undefined) void browse(host, listing.parent) }}>
            上级
          </Button>
          <Button variant="toolbar" size="sm" disabled={busy} onClick={() => { setShowHidden(value => !value) }}>
            {showHidden ? '隐藏隐藏文件' : '显示隐藏文件'}
          </Button>
        </div>

        {/* 目录列表 */}
        <div style={TREE_STYLE}>
          {busy && listing === undefined
            ? <div style={HINT_STYLE}>加载中…</div>
            : visible.length === 0
              ? <div style={HINT_STYLE}>（没有子目录）</div>
              : visible.map(entry => (
                <button
                  key={entry.path}
                  type="button"
                  disabled={busy}
                  onClick={() => { if (host !== undefined) void browse(host, entry.path) }}
                  style={ROW_STYLE}
                >
                  <span>📁 {entry.name}</span>
                  <span style={FACT_STYLE}>{entry.path}</span>
                </button>
              ))}
        </div>
        {error === undefined ? null : <div style={{ ...HINT_STYLE, color: '#c0392b' }}>{error}</div>}
      </div>
    </Modal>
  )
}

/** Colour per verdict tone. */
const TONE_COLOR = { ok: '#3f9a4a', warn: '#b07d18', bad: '#c0392b', busy: '#888888' } as const
const PANEL_STYLE = { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 } as const
const HOST_ROW_STYLE = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } as const
const PATH_ROW_STYLE = { display: 'flex', alignItems: 'center', gap: 8 } as const
const LABEL_STYLE = { fontWeight: 600, fontSize: 13 } as const
const SELECT_STYLE = {
  flex: 'none', minWidth: 220, padding: '5px 8px', borderRadius: 6,
  border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit', font: 'inherit',
} as const
const PATH_STYLE = { flex: 1, fontFamily: 'monospace', fontSize: 12, opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const
const STATUS_STYLE = { fontSize: 12 } as const
const HINT_STYLE = { fontSize: 12, color: '#888888', padding: '8px 0' } as const
const TREE_STYLE = {
  display: 'flex', flexDirection: 'column', gap: 2, height: 320, overflow: 'auto',
  border: '1px solid rgba(127,127,127,0.25)', borderRadius: 8, padding: 6,
} as const
const ROW_STYLE = {
  display: 'flex', justifyContent: 'space-between', gap: 8, textAlign: 'left',
  padding: '6px 8px', borderRadius: 6, border: '1px solid transparent',
  background: 'rgba(127,127,127,0.08)', cursor: 'pointer', color: 'inherit', font: 'inherit', fontSize: 13,
} as const
const FACT_STYLE = { opacity: 0.55, fontFamily: 'monospace', fontSize: 11 } as const

/** Services this plugin reads on the client root. */
export const inject = ['slots', 'workspaces']

/**
 * Register the dialog into both directory-flow holes, shadowing the shipped
 * browse occupant: this plugin registers at priority -1 (ascending order, so
 * it renders first). The callback form keeps the two registrations alive with
 * the owner declarations, exactly like the shipped browse package.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshSshWorkspace = 'dialog-width'
    style.textContent = DIALOG_CSS
    document.head.append(style)
    return () => { style.remove() }
  }, 'ssh-workspace: dialog width')
  const bound = (owner: DirectoryFlowOwnerProps): ReactElement =>
    <RemoteDirectoryBrowser {...owner} ctx={ctx} />
  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
    ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
      yield ctx.slots.register({ name: 'conversation.hero.workspace.directoryFlow', priority: -1 }, bound as never)
      yield ctx.slots.register({ name: 'sidebar.workspaces.directoryFlow', priority: -1 }, bound as never)
    }))
}
