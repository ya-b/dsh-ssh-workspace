/**
 * Build the installable bundle: host entries and the browser client are
 * self-contained ESM/CJS artifacts; the daemon archive sits at `dist/` so the
 * shipped path in `lib/mount.js` resolves inside the installed package.
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const lib = join(root, 'lib')
const dist = join(root, 'dist')

await rm(lib, { recursive: true, force: true })
await rm(dist, { recursive: true, force: true })
await mkdir(lib, { recursive: true })
await mkdir(dist, { recursive: true })

const host = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['@deepseek-ai/*'],
  legalComments: 'none',
  logLevel: 'warning',
}

await build({ ...host, entryPoints: [join(root, 'packages/mount/src/index.ts')], outfile: join(lib, 'mount.js') })
await build({ ...host, entryPoints: [join(root, 'packages/api/src/index.ts')], outfile: join(lib, 'api.js') })
await build({ ...host, entryPoints: [join(root, 'packages/ui/src/index.ts')], outfile: join(lib, 'index.js') })

execFileSync(process.execPath, ['build.mjs'], { cwd: join(root, 'packages/daemon'), stdio: 'inherit' })
execFileSync(process.execPath, ['scripts/archive.mjs'], { cwd: join(root, 'packages/mount'), stdio: 'inherit' })
await cp(join(root, 'packages/mount/dist/daemon.tar.gz'), join(dist, 'daemon.tar.gz'))

execFileSync(process.execPath, [join(root, 'packages/ui/build.mjs')], {
  cwd: join(root, 'packages/ui'),
  stdio: 'inherit',
  env: {
    ...process.env,
    DSH_CLIENT_ID: manifest.name,
    DSH_CLIENT_OUTFILE: join(lib, 'client.js'),
  },
})

console.log(`bundle ${manifest.name} ready (lib/ + dist/daemon.tar.gz)`)
