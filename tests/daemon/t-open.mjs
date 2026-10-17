import { createTransport } from '@dsh-ssh-workspace/providers'
import { homedir } from 'node:os'
import { join } from 'node:path'
const t = createTransport({ host: 'localhost', workspace: join(homedir(),'dsh-ws-probe'), daemonDir: join(homedir(),'.dsh-workspace'), node: '/usr/bin/node', requestTimeoutMs: 15000 })
console.log('opening...')
await t.open()
console.log('open OK', t.hello?.instanceId?.slice(0,8))
await t.dispose()
