import { RemoteWorkspaceTransport } from '@dsh-ssh-workspace/transport'
import { z } from 'zod'
import { homedir } from 'node:os'
import { join } from 'node:path'
const root = join(homedir(), 'dsh-ws-probe')
const config = { host: 'localhost', workspace: root, daemonDir: join(homedir(), '.dsh-workspace'), node: process.execPath, requestTimeoutMs: 20000 }
const t = new RemoteWorkspaceTransport(config)
await t.open()
for (const method of ['fs.resolve', 'fs.stat', 'fs.list']) {
  const started = Date.now()
  for (let i = 0; i < 50; i += 1) {
    const target = await t.request('fs.resolve', { path: join(root, 'note.txt') }, z.object({ targetKey: z.string(), displayPath: z.string() }).loose())
    if (method === 'fs.stat') await t.request('fs.stat', { target }, z.unknown())
    else if (method === 'fs.list') {
      const directory = await t.request('fs.resolve', { path: root }, z.object({ targetKey: z.string(), displayPath: z.string() }).loose())
      await t.request('fs.list', { target: directory }, z.unknown())
    }
  }
  console.log(`${method} x50: ${Math.round((Date.now() - started) / 50)} ms/op`)
}
await t.dispose()
