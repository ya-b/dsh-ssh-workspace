/** Workspace daemon entry: single-instance unix-socket server with a boot token. */
import { createHash, randomUUID } from 'node:crypto'
import { open, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { logSpillFailure } from '@deepseek-ai/dsh-subprocess-local/output'
import { ClientRegistry, serveConnection, type DaemonOptions } from './session.ts'

interface BootstrapConfig {
  roots?: string[]
  defaultMode?: DaemonOptions['defaultMode']
  maxProcessHandles?: number
}

async function loadConfig(dir: string): Promise<BootstrapConfig> {
  const path = join(dir, 'config.json')
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as BootstrapConfig
    return typeof raw === 'object' && raw !== null ? raw : {}
  } catch {
    return {}
  }
}

export interface BootResult { server: Server; instanceId: string; socketPath: string }

/** Boot one daemon on `dir` (socket/pid/lock state) and serve until shutdown. */
export async function boot(dirArg?: string): Promise<BootResult> {
  const dir = resolve(dirArg ?? join(homedir(), '.dsh-workspace'))
  await mkdir(dir, { recursive: true })
  const socketPath = join(dir, 'sock')
  const pidPath = join(dir, 'pid')
  const lockPath = join(dir, 'lock')
  await mkdir(join(dir, 'streams'), { recursive: true })

  // Single instance per state directory: an exclusive lock file refuses boot two.
  const lock = await open(lockPath, 'wx').catch(() => undefined)
  if (lock === undefined) {
    const prior = await readFile(pidPath, 'utf8').catch(() => undefined)
    throw new Error(`workspace daemon already holds ${lockPath}${prior === undefined ? '' : ` (pid ${prior.trim()})`}`)
  }
  const config = await loadConfig(dir)
  const instanceId = `${randomUUID().replaceAll('-', '')}.${process.pid}.${process.hrtime.bigint().toString(16)}`
  // The bundle this process loaded, published for the bootstrap's upgrade
  // check. Written before the socket exists, so a visible socket always
  // implies a fresh digest.
  const digest = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex')
  await writeFile(join(dir, 'running.digest'), `${digest}\n`)
  const spillReporter = logSpillFailure(console as unknown as { error(message: string, ...detail: unknown[]): void }, 'workspace daemon')
  const options: DaemonOptions = {
    dir,
    roots: config.roots ?? [homedir()],
    defaultMode: config.defaultMode ?? 'read-only',
    maxProcessHandles: config.maxProcessHandles ?? 128,
    instanceId,
    spillFailure: (error: unknown): void => { spillReporter(error, 'workspace daemon') },
  }
  const registry = new ClientRegistry(options)
  const server: Server = createServer((client) => {
    void serveConnection(client, options, registry)
  })
  await rm(socketPath, { force: true })
  await new Promise<void>((startResolve, startReject) => {
    server.once('error', startReject)
    server.listen(socketPath, (): void => {
      server.off('error', startReject)
      startResolve()
    })
  })
  await writeFile(pidPath, `${process.pid}\n`)
  await lock.writeFile(`${JSON.stringify({ pid: process.pid, instanceId, dir })}\n`)
  const shutdown = async (): Promise<void> => {
    server.close()
    try {
      const sessionsForShutdown = await registry.all()
      await Promise.allSettled(sessionsForShutdown.map(session => session.dispose()))
    } finally {
      await rm(socketPath, { force: true })
      await rm(pidPath, { force: true })
      // Remove the digest while the lock still blocks a successor: a new
      // daemon may only publish its own after this one is gone.
      await rm(join(dir, 'running.digest'), { force: true })
      await lock.close()
      await rm(lockPath, { force: true })
    }
  }
  let closing = false
  const stop = (): void => {
    if (closing) return
    closing = true
    void shutdown().then(() => { process.exit(0) }, () => { process.exit(1) })
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  return { server, instanceId, socketPath }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`
if (invokedDirectly) {
  const dirArg = process.argv[2] === '--dir' ? process.argv[3] : undefined
  boot(dirArg).then(
    ({ socketPath, instanceId }) => { console.log(`workspace daemon ready on ${socketPath} (${instanceId})`) },
    (error) => { console.error(String(error instanceof Error ? error.message : error)); process.exit(1) },
  )
}
