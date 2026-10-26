/**
 * Durable host attribution for remote workspaces. The 0.2.1 workspace record
 * shape is strict and carries no transport fields, so the plugin keeps its own
 * small sidecar: which Workspace id lives on which SSH host at which canonical
 * remote path. Every router decision (fs path, subprocess cwd, sandbox policy
 * root, terminal session cwd) reads this mapping, and every adopted workspace
 * is written here before its registry record is trusted.
 * @module @dsh-ssh-workspace/mount/state
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { posix } from 'node:path'

/** One remote workspace attribution record. */
export interface RemoteWorkspaceRecord {
  /** Workspace id of the registry entity this record explains. */
  workspaceId: string
  /** OpenSSH host alias the workspace lives on. */
  host: string
  /** Canonical absolute remote directory. */
  path: string
  /** Display title at adoption time (registry keeps the authoritative one). */
  title: string
  /** ISO-8601 adoption timestamp. */
  createdAt: string
}

interface StateFile {
  version: 1
  records: readonly RemoteWorkspaceRecord[]
}

/**
 * Canonical containment test over POSIX spellings: equality or a proper
 * descendant. Both sides are expected canonical (no trailing slash beyond the
 * root, no `.`/`..` segments).
 * @param root - canonical directory path.
 * @param candidate - canonical path to test.
 * @returns true when `candidate` is `root` or below it.
 */
export function within(root: string, candidate: string): boolean {
  if (candidate === root) return true
  const base = root === '/' ? '/' : `${root}/`
  return candidate.startsWith(base)
}

/** Lexical canonical spelling of a remote path (POSIX, no trailing slash). */
export function canonicalSpelling(path: string): string {
  const normalized = posix.normalize(path)
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
}

/** The sidecar store, serialized through a promise tail so writes never interleave. */
export class RemoteWorkspaceState {
  private records: readonly RemoteWorkspaceRecord[] | undefined
  private tail: Promise<unknown> = Promise.resolve()

  private readonly file: string

  /** @param file - absolute path of the JSON sidecar. */
  constructor(file: string) {
    this.file = file
  }

  /** Load (once) and return every attribution record. */
  async list(): Promise<readonly RemoteWorkspaceRecord[]> {
    let records = this.records
    if (records === undefined) {
      const text = await readFile(this.file, 'utf8').catch(() => undefined)
      let parsed: StateFile | undefined
      if (text !== undefined) {
        try {
          const value = JSON.parse(text) as StateFile
          if (value.version === 1 && Array.isArray(value.records)) parsed = value
        } catch { /* a corrupt sidecar reads as empty; it is rebuilt by adoption */ }
      }
      records = parsed?.records ?? []
      this.records = records
    }
    return records
  }

  /** Synchronous snapshot after {@link list} resolved once. */
  snapshot(): readonly RemoteWorkspaceRecord[] {
    return this.records ?? []
  }

  /** Record of one workspace id, when the id is a remote workspace. */
  byWorkspace(workspaceId: string): RemoteWorkspaceRecord | undefined {
    return this.snapshot().find(record => record.workspaceId === workspaceId)
  }

  /** The record covering a canonical path, longest match first. */
  covering(path: string): RemoteWorkspaceRecord | undefined {
    const canonical = canonicalSpelling(path)
    let best: RemoteWorkspaceRecord | undefined
    for (const record of this.snapshot()) {
      if (!within(record.path, canonical)) continue
      if (best === undefined || record.path.length > best.path.length) best = record
    }
    return best
  }

  /** The record with exactly this canonical path, when one exists. */
  exact(path: string): RemoteWorkspaceRecord | undefined {
    const canonical = canonicalSpelling(path)
    return this.snapshot().find(record => record.path === canonical)
  }

  /**
   * The record whose root sits beside a path: `dirname(path)` is the root
   * itself or one of its ancestors. Upstream discovery walks *above* a
   * session cwd probing for markers (`.git`, instruction files), so those
   * probes spell sibling-of-ancestor paths that no {@link covering} match
   * explains. Callers must only use this for read-only probes that the local
   * plane could not even traverse.
   * @param path - canonical spelling of the probed path.
   * @returns the adjacent remote record, first match in insertion order.
   */
  adjacent(path: string): RemoteWorkspaceRecord | undefined {
    const parent = posix.dirname(canonicalSpelling(path))
    return this.snapshot().find(record => within(parent, record.path))
  }

  /** Insert or replace one record and persist. */
  put(record: RemoteWorkspaceRecord): Promise<void> {
    return this.enqueue(async () => {
      const records = [...await this.list()]
      const at = records.findIndex(existing => existing.workspaceId === record.workspaceId)
      if (at === -1) records.push(record)
      else records[at] = record
      this.records = records
      await this.persist(records)
    })
  }

  /** Drop one record and persist; unknown ids are a no-op. */
  remove(workspaceId: string): Promise<void> {
    return this.enqueue(async () => {
      const records = (await this.list()).filter(record => record.workspaceId !== workspaceId)
      this.records = records
      await this.persist(records)
    })
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work)
    this.tail = next.catch(() => undefined)
    return next
  }

  private async persist(records: readonly RemoteWorkspaceRecord[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const body = `${JSON.stringify({ version: 1, records } satisfies StateFile, null, 2)}\n`
    const temporary = `${this.file}.tmp`
    await writeFile(temporary, body, 'utf8')
    await rename(temporary, this.file)
  }
}
