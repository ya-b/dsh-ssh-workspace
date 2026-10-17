import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'

await build({
  entryPoints: ['src/entry.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'lib/workspaced.js',
  logLevel: 'warning',
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __dshCreateRequire } from 'node:module';",
      'const require = __dshCreateRequire(import.meta.url);',
    ].join('\n'),
  },
})

// A few harness packages read their own manifest version relative to the
// module file. Inlined into a single-file bundle that path no longer exists,
// so the build pins the version the bundle was compiled from.
const version = JSON.parse(await readFile('package.json', 'utf8')).version
const bundle = await readFile('lib/workspaced.js', 'utf8')
const rewritten = bundle.replaceAll(
  "createRequire(import.meta.url)(\"../package.json\")",
  `({ version: ${JSON.stringify(version)} })`,
)
if (rewritten.includes('createRequire(import.meta.url)("../package.json")')) {
  throw new Error('daemon bundle still contains a bundle-relative package.json require')
}
await writeFile('lib/workspaced.js', rewritten)
console.log('workspaced.js written to lib/')
