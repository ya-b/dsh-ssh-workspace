/**
 * Browser half of the remote-workspace UI: a sidebar panel that adds a
 * Workspace the plan's way — pick a machine first (this host or any OpenSSH
 * alias), then pick a directory on it. The machine list, the connectivity
 * precheck, and the directory listing all come from this plugin's host half;
 * registering the Workspace goes through the same Host Controller the session
 * execution world is routed by, so a directory added here becomes a real world.
 *
 * Nothing in the harness is modified: the panel lives in the panel list beside
 * the shipped ones.
 * @module @dsh-ssh-workspace/ui/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

// Temporary diagnostics: capture the first render failure of this plugin's
// surfaces on window.__dshWsErrors so it can be read from the page.
if (typeof window !== 'undefined') {
  const scope = window as unknown as { __dshWsErrors?: string[], __dshWsHooked?: boolean }
  if (scope.__dshWsHooked !== true) {
    scope.__dshWsHooked = true
    scope.__dshWsErrors = []
    const original = console.error
    console.error = (...args: unknown[]) => {
      try {
        scope.__dshWsErrors?.push(args.map(part => {
          if (part instanceof Error) return `${part.message} :: ${(part.stack ?? '').slice(0, 300)}`
          return String(part).slice(0, 300)
        }).join(' | ').slice(0, 800))
      } catch { /* diagnostics never throw */ }
      original(...(args as never[]))
    }
  }
}

/** Route prefix of this plugin's host half. */
const API = '/ssh-workspace'

/** Panel identity in the sidebar list and the main column. */
const PANEL_ID = 'ssh-workspace'

/** Services this plugin reads on the client root. */
export const inject = ['slots', 'workspaces']

/** One machine offered by the host half. */
interface Machine {
  alias: string | null
  label: string
  local: boolean
  hostname?: string
  user?: string
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

/** The slice of the Host Controller this plugin uses. */
interface WorkspaceCreator {
  create(input: { path: string, transport?: 'local' | 'ssh', host?: string }): Promise<{ workspaceId: string }>
}

/** How long one host route may take before the panel reports a failure. */
const CALL_TIMEOUT_MS = 15_000

/** Call one host route and unwrap its JSON body or its error message. */
async function call<T>(route: string, query: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${API}${route}`, window.location.origin)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  })
  const body = await response.json().catch(() => undefined) as (T & { error?: string }) | undefined
  if (!response.ok) throw new Error(body?.error ?? `${String(response.status)} ${response.statusText}`)
  return body as T
}

/**
 * The machine list is one answer per page session: a panel that remounts (the
 * shell may re-register its surfaces) reuses it instead of opening a second
 * request, which is what keeps a slow host from stacking connections.
 */
let machinesOnce: Promise<Machine[]> | undefined
function loadMachines(): Promise<Machine[]> {
  machinesOnce ??= call<{ machines: Machine[] }>('/machines').then(result => result.machines).catch((error: unknown) => {
    machinesOnce = undefined
    throw error
  })
  return machinesOnce
}

/** Prechecks are cached per alias: the verdict of a machine does not move by the second. */
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

/** Directory listings are cached per machine and path for the page session. */
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

/** Machine picker and directory browser, in one panel. */
export function RemoteWorkspacePanel({ ctx }: { ctx: Context }): ReactElement {
  const [machines, setMachines] = useState<Machine[] | undefined>(undefined)
  const [selected, setSelected] = useState<Machine | undefined>(undefined)
  const [precheck, setPrecheck] = useState<Precheck | undefined>(undefined)
  const [checking, setChecking] = useState(false)
  const [listing, setListing] = useState<Listing | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [added, setAdded] = useState<string | undefined>(undefined)
  const [manual, setManual] = useState('')

  useEffect(() => {
    loadMachines()
      .then(result => { setMachines(result) })
      .catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) })
  }, [])

  const openMachine = useCallback(async (machine: Machine): Promise<void> => {
    setSelected(machine)
    setPrecheck(undefined)
    setListing(undefined)
    setError(undefined)
    setAdded(undefined)
    if (machine.local) return
    setChecking(true)
    try {
      setPrecheck(await precheckOf(machine.alias ?? ''))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setChecking(false)
    }
  }, [])

  const browse = useCallback(async (path: string): Promise<void> => {
    if (selected === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      setListing(await listingOf(selected.alias ?? undefined, path))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [selected])

  const add = useCallback(async (): Promise<void> => {
    if (selected === undefined || listing === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      const workspaces = ctx.get('workspaces') as unknown as WorkspaceCreator
      const workspace = await workspaces.create({
        path: listing.path,
        ...(selected.alias === null ? {} : { transport: 'ssh' as const, host: selected.alias }),
      })
      setAdded(workspace.workspaceId)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [ctx, listing, selected])

  const remoteReady = selected !== undefined && (selected.local || precheck?.status === 'usable')
  const status = usedStatus(selected, checking, precheck)

  return (
    <div style={PANEL_STYLE}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>添加远程工作区</div>
      <div style={HINT_STYLE}>先选机器，再选目录。选定后该工作区的文件、终端与命令都在那台机器上执行。</div>
      <div style={LIST_STYLE}>
        {machines === undefined
          ? <div style={HINT_STYLE}>正在读取 ~/.ssh/config…</div>
          : machines.map(machine => (
            <button
              key={machine.alias ?? 'local'}
              type="button"
              onClick={() => { void openMachine(machine) }}
              style={{ ...ROW_STYLE, borderColor: selected === machine ? '#4a8cff' : 'transparent' }}
            >
              <span>{machine.label}</span>
              <span style={FACT_STYLE}>
                {machine.local
                  ? '本机'
                  : [machine.user, machine.hostname === undefined ? undefined : `@${machine.hostname}`,
                    machine.port === undefined ? undefined : `:${String(machine.port)}`]
                    .filter(part => part !== undefined).join('')}
              </span>
            </button>
          ))}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <input
          value={manual}
          placeholder="或直接输入主机别名，例如 localhost"
          onChange={(event) => { setManual(event.target.value) }}
          style={INPUT_STYLE}
        />
        <button
          type="button"
          disabled={manual.trim() === ''}
          onClick={() => { void openMachine({ alias: manual.trim(), label: manual.trim(), local: false }) }}
          style={ACTION_STYLE}
        >
          使用该主机
        </button>
      </div>
      {status === undefined ? null : <div style={{ ...HINT_STYLE, color: TONE_COLOR[status.tone] }}>{status.text}</div>}
      {!remoteReady ? null : (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <button type="button" disabled={busy} onClick={() => { void browse(listing?.path ?? '') }} style={ACTION_STYLE}>浏览目录</button>
            {listing?.parent === undefined ? null : (
              <button type="button" disabled={busy} onClick={() => { void browse(listing?.parent ?? '') }} style={ACTION_STYLE}>上级</button>
            )}
            {listing === undefined ? null : (
              <button type="button" disabled={busy} onClick={() => { void add() }} style={{ ...ACTION_STYLE, background: '#4a8cff', color: '#fff' }}>
                把此目录添加为工作区
              </button>
            )}
          </div>
          {listing === undefined ? null : <div style={{ ...HINT_STYLE, fontFamily: 'monospace' }}>{listing.path}</div>}
          {listing === undefined ? null : (
            <div style={{ ...LIST_STYLE, maxHeight: 260, overflow: 'auto' }}>
              {listing.entries.length === 0
                ? <div style={HINT_STYLE}>（没有子目录）</div>
                : listing.entries.map(entry => (
                  <button
                    key={entry.path}
                    type="button"
                    disabled={busy}
                    onClick={() => { void browse(entry.path) }}
                    style={{ ...ROW_STYLE, opacity: entry.hidden ? 0.6 : 1 }}
                  >
                    {entry.name}
                  </button>
                ))}
            </div>
          )}
        </div>
      )}
      {added === undefined ? null : (
        <div style={{ ...HINT_STYLE, color: '#3f9a4a' }}>已添加工作区（{added.slice(0, 8)}），可在左侧工作区列表中使用。</div>
      )}
      {error === undefined ? null : <div style={{ ...HINT_STYLE, color: '#c0392b' }}>{error}</div>}
    </div>
  )
}

/** The one-line machine verdict, absent until a machine is chosen. */
function usedStatus(
  selected: Machine | undefined,
  checking: boolean,
  precheck: Precheck | undefined,
): { text: string, tone: keyof typeof TONE_COLOR } | undefined {
  if (selected === undefined) return undefined
  if (selected.local) return { text: '本机：无需 SSH', tone: 'ok' }
  if (checking) return { text: '检测中…', tone: 'busy' }
  if (precheck === undefined) return undefined
  const tone = precheck.status === 'usable' ? 'ok' : precheck.status === 'needs-credentials' ? 'warn' : 'bad'
  return { text: `${precheck.status}: ${precheck.detail}`, tone }
}

/** Colour per verdict tone, so the badge reads at a glance. */
const TONE_COLOR = { ok: '#3f9a4a', warn: '#b07d18', bad: '#c0392b', busy: '#888888' } as const
const PANEL_STYLE = { padding: 16, fontSize: 13, maxWidth: 720 } as const
const HINT_STYLE = { fontSize: 12, color: '#888888', margin: '4px 0' } as const
const LIST_STYLE = { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 8 } as const
const ROW_STYLE = {
  display: 'flex', justifyContent: 'space-between', gap: 8, textAlign: 'left',
  padding: '6px 8px', borderRadius: 6, border: '1px solid transparent',
  background: 'rgba(127,127,127,0.08)', cursor: 'pointer', color: 'inherit', font: 'inherit',
} as const
const FACT_STYLE = { opacity: 0.6, fontFamily: 'monospace' } as const
const FOOTER_STYLE = {
  padding: '4px 8px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.3)',
  background: 'rgba(127,127,127,0.08)', cursor: 'pointer', color: 'inherit', font: 'inherit',
} as const
const OVERLAY_STYLE = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000,
  display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '8vh',
} as const
const DIALOG_STYLE = {
  width: 'min(720px, 92vw)', maxHeight: '80vh', overflow: 'auto', background: 'var(--dsh-surface, #1b1b1f)',
  color: 'inherit', borderRadius: 10, padding: 16, boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
} as const
const INPUT_STYLE = {
  flex: 1, padding: '5px 8px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.35)',
  background: 'transparent', color: 'inherit', font: 'inherit',
} as const
const ACTION_STYLE = {
  padding: '5px 10px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.35)',
  background: 'rgba(127,127,127,0.1)', cursor: 'pointer', color: 'inherit', font: 'inherit',
} as const

/** The footer button and the dialog it opens; the dialog is portalled so it
 * cannot be clipped by the sidebar column. */
function FooterAction({ ctx }: { ctx: Context }): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => { setOpen(value => !value) }} style={FOOTER_STYLE} aria-label="远程工作区">
        🌐
      </button>
      {!open ? null : createPortal(
        <div style={OVERLAY_STYLE} onClick={() => { setOpen(false) }}>
          <div style={DIALOG_STYLE} onClick={event => { event.stopPropagation() }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontWeight: 600 }}>远程工作区</span>
              <button type="button" onClick={() => { setOpen(false) }} style={ACTION_STYLE}>关闭</button>
            </div>
            <RemoteWorkspacePanel ctx={ctx} />
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

/**
 * Register the panel's sidebar icon, its main-column content, and a footer
 * button that opens the same picker as a dialog (a session view occupies the
 * main column, so the dialog is the path that always works).
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const Panel = (): ReactElement => <RemoteWorkspacePanel ctx={ctx} />
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: PANEL_ID, order: 20 },
    () => <FooterAction ctx={ctx} />,
  ))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    label: '远程工作区',
    order: 30,
  }, () => <span aria-hidden="true">🌐</span>))
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel))
}
