import { createConnection } from 'node:net'
import { connect } from 'node:tls'
import { RpcPeer } from '@dsh-ssh-workspace/rpc'
import { z } from 'zod'

const dir = process.argv[2]
const socket = createConnection({ path: `${dir}/sock`, allowHalfOpen: true })
await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
const peer = new RpcPeer(socket, socket, 64 * 1024 * 1024, 128)
const hello = await peer.requestRaw('hello', { protocol: 1, workspace: '/tmp/dsh-ws-test/w1', clientUuid: 'probe-client-0001' })
console.log('hello:', JSON.stringify(hello))

const prepared = await peer.requestRaw('process.prepare', {
  opId: 'a'.repeat(32),
  argv: ['/bin/sh', '-c', 'echo hello-$((6*7)); echo err-line >&2; exit 3'],
  cwd: '/tmp/dsh-ws-test/w1', graceMs: 2000,
  stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
})
console.log('prepared:', JSON.stringify(prepared))

const attach = async (endpoint) => {
  const raw = createConnection({ path: endpoint.path, allowHalfOpen: true })
  await new Promise((resolve, reject) => { raw.once('connect', resolve); raw.once('error', reject) })
  const tls = connect({
    ciphers: 'PSK-AES256-GCM-SHA384', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', socket: raw,
    rejectUnauthorized: true, checkServerIdentity: () => undefined,
    pskCallback: () => ({ psk: Buffer.from(endpoint.capability, 'hex'), identity: 'dsh-stream' }),
  })
  await new Promise((resolve, reject) => { tls.once('secureConnect', resolve); tls.once('error', reject) })
  const body = Buffer.from(JSON.stringify({ sync: 0 }))
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length)
  tls.write(Buffer.concat([header, body]))
  return tls
}

const stdout = await attach(prepared.streams.stdout)
const stderr = await attach(prepared.streams.stderr)
let out = Buffer.alloc(0)
let err = Buffer.alloc(0)
stdout.on('data', c => { out = Buffer.concat([out, c]) })
stderr.on('data', c => { err = Buffer.concat([err, c]) })

const started = await peer.requestRaw('process.start', { id: prepared.id })
console.log('started:', JSON.stringify(started))
const done = await peer.requestRaw('process.done', { id: prepared.id })
console.log('done:', JSON.stringify(done))
await new Promise(r => setTimeout(r, 150))
console.log('stdout bytes:', JSON.stringify(out.toString()))
console.log('stderr bytes:', JSON.stringify(err.toString()))

// opId resubmission must return the same reservation and never spawn again.
const again = await peer.requestRaw('process.prepare', {
  opId: 'a'.repeat(32),
  argv: ['/bin/sh', '-c', 'echo SECOND-SPAWN; exit 9'],
  cwd: '/tmp/dsh-ws-test/w1', graceMs: 2000,
  stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
})
console.log('resubmit same id:', again.id === prepared.id ? 'SAME' : `DIFFERENT ${again.id}`)
const done2 = await peer.requestRaw('process.done', { id: again.id })
console.log('resubmit terminal:', JSON.stringify(done2))

// fs round trip
const resolved = await peer.requestRaw('fs.resolve', { path: '/tmp/dsh-ws-test/w1' })
console.log('fs.resolve:', JSON.stringify(resolved))
const write = await peer.requestRaw('fs.write', {
  target: resolved, content: 'hello daemon\n',
  expected: { kind: 'createIfAbsent' },
  policy: { mode: 'workspace-write', workspaceRoot: '/tmp/dsh-ws-test/w1' },
  opId: 'b'.repeat(32),
})
console.log('fs.write:', JSON.stringify(write))
const read = await peer.requestRaw('fs.readText', { target: resolved })
console.log('fs.readText:', JSON.stringify(read))
const write2 = await peer.requestRaw('fs.write', {
  target: resolved, content: 'hello daemon\n',
  expected: { kind: 'createIfAbsent' },
  policy: { mode: 'workspace-write', workspaceRoot: '/tmp/dsh-ws-test/w1' },
  opId: 'b'.repeat(32),
})
console.log('fs.write memoized identical:', JSON.stringify(write2) === JSON.stringify(write) ? 'YES' : 'NO')
const list = await peer.requestRaw('fs.list', { target: resolved })
console.log('fs.list:', JSON.stringify(list))
peer.close()
