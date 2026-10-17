import { RemoteWorkspaceTransport } from '@dsh-ssh-workspace/transport'
import { z } from 'zod'
import { homedir } from 'node:os'
import { join } from 'node:path'
const config = { host: 'localhost', workspace: join(homedir(), 'dsh-ws-probe'), daemonDir: join(homedir(), '.dsh-workspace'), node: process.execPath, requestTimeoutMs: 20000 }
const t = new RemoteWorkspaceTransport(config)
await t.open()
const target = await t.request('fs.resolve', { path: join(homedir(), 'dsh-ws-probe') }, z.object({ targetKey: z.string(), displayPath: z.string() }).loose())
const started = Date.now()
for (let i = 0; i < 100; i += 1) await t.request('fs.stat', { target }, z.unknown())
const each = (Date.now() - started) / 100
console.log(`fs.stat x100: ${Math.round(each)} ms/op`)
await t.dispose()
