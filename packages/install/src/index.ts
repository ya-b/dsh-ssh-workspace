/**
 * Daemon deployment: package the single-file daemon plus its only native
 * dependency (node-pty, for PTY terminals) into one archive and install it on
 * a remote host over an SSH channel. Everything else the daemon needs is
 * inlined in the bundle.
 * @module @dsh-ssh-workspace/install
 */

import { execFile } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { daemonDirExpr, type RemoteWorkspaceConfig } from '@dsh-ssh-workspace/transport'

/** Files the daemon bundle needs beside it: its own version manifest and node-pty. */
export interface DaemonArchiveInput {
  /** Absolute path of the built `workspaced.js`. */
  bundlePath: string
  /** Directory holding `node-pty` (its package root), when terminals are wanted. */
  nodePtyDir?: string
  /** Remote platform, used to select the prebuilt native binary. */
  platform?: 'linux' | 'darwin'
  /** Remote architecture. */
  arch?: string
}

/** Remote command: extract the daemon archive into its state directory. */
export function installCommand(config: RemoteWorkspaceConfig): string {
  const dir = daemonDirExpr(config.daemonDir)
  return [
    `D=${dir}`,
    'mkdir -p "$D" && chmod 700 "$D"',
    'tar -xzf - -C "$D"',
    'chmod 700 "$D/workspaced.js"',
  ].join('; ')
}

/**
 * Build the install archive: `workspaced.js`, a version manifest for the
 * bundle-relative metadata lookups, and the platform-trimmed node-pty tree.
 */
export async function buildDaemonArchive(input: DaemonArchiveInput): Promise<Buffer> {
  const staging = await mkdtemp(join(tmpdir(), 'dsh-ws-pack-'))
  try {
    await copyFile(input.bundlePath, join(staging, 'workspaced.js'))
    const version = JSON.parse(await readFile(new URL('../../daemon/package.json', import.meta.url), 'utf8')).version as string
    await writeFile(join(staging, 'package.json'), `${JSON.stringify({ name: 'workspace-daemon', version, private: true, type: 'module' }, null, 2)}\n`)
    if (input.nodePtyDir !== undefined) {
      const platform = input.platform ?? 'linux'
      const arch = input.arch ?? process.arch
      const target = join(staging, 'node_modules', 'node-pty')
      await mkdir(dirname(target), { recursive: true })
      await copyTree(input.nodePtyDir, target, (name, relativePath) => {
        if (relativePath === '') return name === 'package.json' || name === 'lib' || name === 'prebuilds'
        if (relativePath === 'prebuilds') return name === `${platform}-${arch}`
        return !name.startsWith('.')
      })
      await writeFile(join(target, 'prebuilds', `${platform}-${arch}`, '.keep'), '')
    }
    return await tarArchive(staging)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/** Copy a directory tree, keeping entries accepted by `keep` (name + relative path). */
async function copyTree(
  source: string, destination: string,
  keep: (name: string, relativePath: string) => boolean,
  relativePath = '',
): Promise<void> {
  const { readdir } = await import('node:fs/promises')
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!keep(entry.name, relativePath)) continue
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) await copyTree(from, to, keep, relativePath === '' ? entry.name : `${relativePath}/${entry.name}`)
    else if (entry.isFile()) await copyFile(from, to)
  }
}

/** Create a gzip tar of a directory's contents (POSIX `tar`, no extra dependency). */
async function tarArchive(directory: string): Promise<Buffer> {
  const output = await new Promise<Buffer>((resolve, reject) => {
    execFile('tar', ['-czf', '-', '-C', directory, '.'], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 },
      (error, stdout) => { if (error === null) resolve(stdout); else reject(error) })
  })
  return output
}

/** Install the daemon archive on one remote host through a dedicated SSH channel. */
export async function installDaemonArchive(
  config: RemoteWorkspaceConfig, archive: Buffer, deadlineMs = 120_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile('ssh', [
      '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no',
      '-o', 'ClearAllForwardings=yes', config.host, installCommand(config),
    ], { maxBuffer: 1024 * 1024, timeout: deadlineMs }, (error) => { if (error === null) resolve(); else reject(error) })
    child.stdin?.end(archive)
    child.stderr?.resume()
  })
}

/** Resolve the local node-pty package directory from a harness checkout, when present. */
export async function findNodePty(harnessRoot: string): Promise<string | undefined> {
  const candidates = [join(harnessRoot, 'node_modules', 'node-pty')]
  try {
    const { readdir } = await import('node:fs/promises')
    const pnpm = join(harnessRoot, 'node_modules', '.pnpm')
    for (const entry of await readdir(pnpm).catch(() => [] as string[])) {
      if (entry.startsWith('node-pty@')) candidates.push(join(pnpm, entry, 'node_modules', 'node-pty'))
    }
  } catch { /* pnpm layout is optional */ }
  for (const candidate of candidates) {
    try { await access(join(candidate, 'package.json'), constants.R_OK); return candidate } catch { /* try next */ }
  }
  return undefined
}
