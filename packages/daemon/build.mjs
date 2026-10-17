import { build } from 'esbuild'

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
console.log('workspaced.js written to lib/')
