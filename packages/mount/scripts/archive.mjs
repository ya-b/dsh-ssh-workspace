/**
 * Build the daemon install archive shipped beside this package. Run after the
 * daemon bundle changes: pnpm run archive (from packages/mount).
 */
import { buildDaemonArchive, findNodePty } from '@dsh-ssh-workspace/install'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const bundlePath = join(repo, 'packages/daemon/lib/workspaced.js')
const nodePtyDir = await findNodePty(repo) ?? await findNodePty(join(repo, '../deepseek-harness'))
const archive = await buildDaemonArchive({
  bundlePath,
  ...(nodePtyDir === undefined ? {} : { nodePtyDir }),
  platform: 'linux',
  archs: ['x64', 'arm64'],
})
const target = join(repo, 'packages/mount/dist/daemon.tar.gz')
await mkdir(dirname(target), { recursive: true })
await writeFile(target, archive)
console.log(`daemon archive written to ${target} (${(archive.length / 1024 / 1024).toFixed(1)} MiB, node-pty=${nodePtyDir === undefined ? 'absent' : 'included'})`)
