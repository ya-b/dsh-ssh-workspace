/** Build the browser bundle: one CJS factory registered with the module loader. */
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const id = process.env.DSH_CLIENT_ID ?? '@dsh-ssh-workspace/ui'
const outfile = resolve(process.env.DSH_CLIENT_OUTFILE ?? 'lib/client.js')

await mkdir(dirname(outfile), { recursive: true })
await build({
  entryPoints: [fileURLToPath(new URL('./src/client/index.tsx', import.meta.url))],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  outfile,
  logLevel: 'warning',
  external: [
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
  ],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
})
console.log(`client bundle written to ${outfile}`)
