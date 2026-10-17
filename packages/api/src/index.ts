/**
 * Host half of the remote-workspace UI: the machine list behind `~/.ssh/config`,
 * a per-machine connectivity precheck, and a directory browser that speaks
 * through the same realm a session uses. The browser half consumes these over
 * three read-only routes under one prefix; every handler reuses the host
 * connection's own request admission, so an unauthenticated request is rejected
 * exactly like an unauthenticated RPC call.
 *
 * The routes are deliberately thin: host enumeration is pure filesystem work,
 * while browse and verify go through `workspaceRuntime`, which means a remote
 * listing is produced by the durable workspace daemon rather than by a new
 * transport path invented here.
 * @module @dsh-ssh-workspace/api
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the Context merges this half reads (`connection`,
// `webServer`, `workspaceRuntime`).
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-host-execution-worlds'
import { execFile } from 'node:child_process'
import { globSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { dirname, isAbsolute, join, posix } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Default route prefix owned by this plugin. */
const DEFAULT_PREFIX = '/ssh-workspace'

/** Options of the machine list and directory routes. */
export interface Config {
  /** Route prefix; must not collide with another plugin's routes. */
  prefix?: string
  /** Per-command budget for the SSH probes, in milliseconds. */
  probeTimeoutMs?: number
  /** Host aliases hidden from the list (for example an automation account). */
  hiddenHosts?: string[]
}

/** One machine the picker may offer. */
export interface MachineEntry {
  /** OpenSSH host alias, or null for the machine running the Host. */
  alias: string | null
  /** Display name: the alias, or the local hostname. */
  label: string
  /** Whether this entry is the machine running the Host. */
  local: boolean
  /** Config facts known without touching the network. */
  hostname?: string
  user?: string
  port?: number
}

/** Connectivity verdict of one machine. */
export type MachineStatus = 'usable' | 'needs-credentials' | 'unreachable' | 'unknown'

/** Result of probing one machine. */
export interface PrecheckResult {
  alias: string
  status: MachineStatus
  /** Operator-facing one-liner; the picker shows it verbatim. */
  detail: string
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

/** Services the routes read. */
export const inject = ['webServer', 'workspaceRuntime', 'connection']

/** SSH config statements this parser understands. */
const INCLUDE_PATTERN = /^\s*Include\s+(.+)$/iu
const HOST_PATTERN = /^\s*Host\s+(.+)$/iu

/**
 * Mount the three read-only routes.
 * @param ctx - host plugin context.
 * @param config - resolved plugin config.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const prefix = normalizePrefix(config.prefix ?? DEFAULT_PREFIX)
  const probeTimeoutMs = config.probeTimeoutMs ?? 8000
  const hidden = new Set(config.hiddenHosts ?? [])
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: prefix,
    handler: (request, response) => {
      handle(ctx, request, response, { prefix, probeTimeoutMs, hidden }).catch((error: unknown) => {
        writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      })
    },
  }), 'ssh-workspace: machine and directory routes')
}

/** Resolve one request to a route. */
async function handle(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
  options: { prefix: string, probeTimeoutMs: number, hidden: Set<string> },
): Promise<void> {
  const admission = ctx.connection.admit(request)
  if ('rejection' in admission) {
    response.writeHead(admission.rejection)
    response.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  const url = new URL(request.url ?? '/', 'http://localhost')
  const route = url.pathname.slice(options.prefix.length)
  if (request.method !== 'GET') {
    writeJson(response, 405, { error: 'these routes are read-only' })
    return
  }
  switch (route) {
    case '/machines':
      writeJson(response, 200, { machines: await listMachines(options.hidden) })
      return
    case '/precheck':
      writeJson(response, 200, await precheck(required(url, 'host'), options.probeTimeoutMs))
      return
    case '/browse':
      writeJson(response, 200, await browse(ctx, url.searchParams.get('host'), url.searchParams.get('path') ?? ''))
      return
    default:
      writeJson(response, 404, { error: `unknown route ${JSON.stringify(route)}` })
  }
}

/** One required query parameter. */
function required(url: URL, name: string): string {
  const value = url.searchParams.get(name)
  if (value === null || value === '') throw new Error(`missing required query parameter ${JSON.stringify(name)}`)
  return value
}

/** A prefix that always starts and ends with a slash and never escapes the mount root. */
function normalizePrefix(prefix: string): string {
  const withLeading = prefix.startsWith('/') ? prefix : `/${prefix}`
  return withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading
}

/** Send one JSON body and end the response. */
function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(payload.length) })
  response.end(payload)
}

/**
 * The machine list: the Host itself first, then every concrete host alias the
 * OpenSSH client would resolve, in config order.
 * @param hidden - aliases to omit.
 * @returns local first, remote aliases after.
 */
async function listMachines(hidden: Set<string>): Promise<MachineEntry[]> {
  const local: MachineEntry = { alias: null, label: hostname(), local: true }
  const machines: MachineEntry[] = [local]
  for (const alias of await hostAliases(homedir())) {
    if (hidden.has(alias)) continue
    const facts = await sshConfigFacts(alias)
    machines.push({ alias, label: alias, local: false, ...facts })
  }
  return machines
}

/**
 * Every concrete `Host` alias declared for this user, following `Include`.
 * Wildcard and negated patterns are skipped: they name rules, not machines.
 * @param home - the user's home directory.
 * @returns alias names in declaration order, deduplicated.
 */
export async function hostAliases(home: string): Promise<string[]> {
  const aliases: string[] = []
  const seen = new Set<string>()
  const visited = new Set<string>()
  const configPath = join(home, '.ssh', 'config')
  const queue = [configPath]
  while (queue.length > 0) {
    const file = queue.shift() as string
    if (visited.has(file)) continue
    visited.add(file)
    const text = await readFile(file, 'utf8').catch(() => undefined)
    if (text === undefined) continue
    for (const line of text.split(/\r?\n/u)) {
      const include = INCLUDE_PATTERN.exec(line)
      if (include !== null) {
        for (const pattern of splitStatements(include[1] as string)) {
          const expanded = pattern.startsWith('~/') ? join(home, pattern.slice(2)) : pattern
          const absolute = isAbsolute(expanded) ? expanded : join(dirname(file), expanded)
          for (const match of globSync(absolute)) queue.push(match)
        }
        continue
      }
      const host = HOST_PATTERN.exec(line)
      if (host === null) continue
      for (const alias of splitStatements(host[1] as string)) {
        if (alias.includes('*') || alias.includes('?') || alias.startsWith('!')) continue
        if (seen.has(alias)) continue
        seen.add(alias)
        aliases.push(alias)
      }
    }
  }
  return aliases
}

/** Whitespace-separated operands of one SSH config statement. */
function splitStatements(value: string): string[] {
  return value.trim().split(/\s+/u).filter(part => part !== '')
}

/** Run `ssh -G` and read the effective hostname, user, and port. */
async function sshConfigFacts(alias: string): Promise<{ hostname?: string, user?: string, port?: number }> {
  const output = await run('ssh', ['-G', alias], 5000).catch(() => undefined)
  if (output === undefined) return {}
  const facts: { hostname?: string, user?: string, port?: number } = {}
  for (const line of output.stdout.split('\n')) {
    const [key, value] = line.trim().split(/\s+/u)
    if (key === 'hostname' && value !== undefined) facts.hostname = value
    if (key === 'user' && value !== undefined) facts.user = value
    if (key === 'port' && value !== undefined) facts.port = Number(value)
  }
  return facts
}

/**
 * Probe one machine with a batch-mode SSH connection and classify the failure.
 * @param alias - OpenSSH host alias.
 * @param timeoutMs - per-command budget.
 * @returns the verdict the picker renders as a badge.
 */
export async function precheck(alias: string, timeoutMs = 8000): Promise<PrecheckResult> {
  const config = await run('ssh', ['-G', alias], Math.min(timeoutMs, 5000)).catch(() => undefined)
  if (config === undefined) {
    return { alias, status: 'unknown', detail: `OpenSSH does not know the host alias ${JSON.stringify(alias)}` }
  }
  try {
    await run('ssh', [
      '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no',
      '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=4', alias, 'true',
    ], timeoutMs)
    return { alias, status: 'usable', detail: `non-interactive SSH login works on ${alias}` }
  } catch (error) {
    const failure = error as Error & { killed?: boolean, stderr?: string }
    const text = (failure.stderr ?? '').trim() === '' ? failure.message : (failure.stderr as string).trim()
    if (failure.killed === true) return { alias, status: 'unreachable', detail: `timed out after ${String(timeoutMs)}ms` }
    const credentials = /permission denied|publickey|no supported authentication|password/i.test(text)
    return { alias, status: credentials ? 'needs-credentials' : 'unreachable', detail: firstLine(text) }
  }
}

/** The first non-empty line of a diagnostic block. */
function firstLine(text: string): string {
  return text.split('\n').map(line => line.trim()).find(line => line !== '') ?? text
}

/**
 * List one directory level on one machine through the execution world a session
 * would use: the local host plane for the local machine, and the durable
 * workspace daemon realm for a remote alias.
 * @param ctx - host plugin context.
 * @param host - OpenSSH alias, or null/absent for the local machine.
 * @param path - absolute directory path; empty selects the machine's home.
 */
export async function browse(ctx: Context, host: string | null, path: string): Promise<BrowseListing> {
  const remote = host !== null && host !== ''
  const machine = host ?? 'this machine'
  const world = await withDeadline(worldFor(ctx, host, path), BROWSE_DEADLINE_MS, `opening the execution world for ${machine}`)
  const requested = path === '' ? (remote ? await remoteHome(ctx, host) : homedir()) : path
  const resolved = await world.fs.resolve(requested)
  const info = await world.fs.stat(resolved)
  if (info?.type !== 'directory') throw new Error(`${JSON.stringify(requested)} is not a directory on ${machine}`)
  const canonical = world.fs.processPath(resolved)
  const entries = await world.fs.listDir(resolved)
  const parent = posix.dirname(canonical)
  return {
    path: canonical,
    ...(parent === canonical ? {} : { parent }),
    entries: entries
      .filter(entry => entry.type === 'directory')
      .map(entry => ({ name: entry.name, path: world.fs.processPath(entry.target), hidden: entry.name.startsWith('.') }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  }
}

/** Budget for resolving a world plus the listing that follows it. */
const BROWSE_DEADLINE_MS = 30_000

/**
 * Bound one user-initiated step. The durable transport deliberately retries a
 * lost session forever, which is right for a running session and wrong for a
 * picker: a picker must answer, or fail with an explanation.
 * @param value - the pending step.
 * @param ms - budget in milliseconds.
 * @param what - operator-facing description of the step.
 */
async function withDeadline<T>(value: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      value,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${String(ms)}ms while ${what}`)), ms)
        timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** The execution world of one machine, exactly as a session would resolve it. */
async function worldFor(ctx: Context, host: string | null, path: string) {
  const remote = host !== null && host !== ''
  return await ctx.workspaceRuntime.worldForWorkspace({
    id: `picker:${host ?? 'local'}`,
    path: path === '' ? '/' : path,
    transport: remote ? 'ssh' : 'local',
    ...(remote ? { host } : {}),
  } as never)
}

/** Resolve one remote machine's home directory through its realm. */
async function remoteHome(ctx: Context, host: string): Promise<string> {
  const world = await worldFor(ctx, host, '/')
  const resolved = await world.fs.resolve('~').catch(() => world.fs.resolve('/'))
  return world.fs.processPath(resolved)
}

/** Run one command, resolving with its output or rejecting with the failure. */
function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null, stdout: string, stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) {
        resolvePromise({ code: 0, stdout, stderr })
        return
      }
      const failure = error as Error & { code?: number | null, killed?: boolean, stderr?: string }
      const merged = { stderr: stderr === '' ? (failure.stderr ?? '') : stderr }
      reject(Object.assign(new Error(firstLine(merged.stderr) || failure.message), {
        code: typeof failure.code === 'number' ? failure.code : null,
        killed: failure.killed === true,
        stderr: merged.stderr,
      }))
    })
  })
}

