/**
 * A3 probe: mount the official SSH provider family over the daemon-backed
 * `ctx.ssh` and exercise fs / subprocess / sandbox / shell through it.
 * Usage: node probe-providers.mjs
 */
import { Context } from '@deepseek-ai/cordis'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'
import { SshSandboxProvider } from '@deepseek-ai/dsh-sandbox-ssh'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { DaemonSshConnection, createTransport } from '@dsh-ssh-workspace/providers'
import { homedir } from 'node:os'
import { join } from 'node:path'

const WORKSPACE = join(homedir(), 'dsh-ws-probe')
const config = {
  host: 'localhost', workspace: WORKSPACE,
  daemonDir: join(homedir(), '.dsh-workspace'), node: '/usr/bin/node',
  requestTimeoutMs: 20_000, reconnectBaseMs: 100, reconnectMaxMs: 1000,
}

const passed = []
function check(name, ok, detail = '') {
  passed.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

const ctx = new Context()
const fibers = []
fibers.push(await ctx.plugin(SessionProjectionRegistry))
fibers.push(await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: WORKSPACE }))
const transport = createTransport(config)
const TRACE = process.env.PROBE_TRACE === '1'
const traced = TRACE ? new Proxy(transport, {
  get(target, name) {
    const value = target[name]
    if (typeof value !== 'function') return value
    return (...args) => {
      const started = Date.now()
      if (name === 'request') console.log('[rpc→]', args[0], JSON.stringify(args[1] ?? {}))
      const call = value.apply(target, args)
      if (call instanceof Promise) {
        call.then(() => { if (name === 'request' || name === 'connectStream') console.log(`[rpc←] ${String(name)} ${args[0] ?? ''} ${Date.now() - started}ms`) },
          error => { if (name === 'request' || name === 'connectStream') console.log(`[rpc✗] ${String(name)} ${args[0] ?? ''} ${Date.now() - started}ms ${error?.message?.slice(0, 80)}`) })
      }
      return call
    }
  },
}) : transport
fibers.push(await ctx.plugin(DaemonSshConnection, { transport: traced }))
fibers.push(await ctx.plugin(SshFileSystem))
fibers.push(await ctx.plugin(SshSubprocessRuntime))
fibers.push(await ctx.plugin(SshSandboxProvider))
fibers.push(await ctx.plugin(SandboxBashExecutor, {}))

const fs = ctx.get('fs')
const subprocess = ctx.get('subprocess')
check('official providers mounted', fs !== undefined && subprocess !== undefined, `sandbox=${ctx.get('sandbox') !== undefined} shell=${ctx.get('shell') !== undefined}`)
check('sandboxMode resolves from host-plane policy', fs.sandboxMode === 'workspace-write', String(fs.sandboxMode))

// fs: resolve → write → read → list → edit
const dirTarget = await fs.resolve(WORKSPACE)
const fileTarget = await fs.resolve(join(WORKSPACE, 'provider-note.txt'))
await import('node:fs/promises').then(fsModule => fsModule.rm(fileTarget.targetKey, { force: true }))
const outcome = await fs.writeText(fileTarget, 'alpha\n', { kind: 'createIfAbsent' })
check('fs.writeText through the official provider', outcome.operation === 'create' || outcome.operation === 'update', outcome.version.slice(0, 7))
check('fs.readText round trip', (await fs.readText(fileTarget)) === 'alpha\n')
const edited = await fs.editText(fileTarget, { oldString: 'alpha', newString: 'beta', replaceAll: false }, { version: outcome.version })
check('fs.editText atomic version guard', (await fs.readText(fileTarget)) === 'beta\n', edited.version.slice(0, 7))
const entries = await fs.listDir(dirTarget)
check('fs.listDir returns entries', entries.some(entry => entry.name === 'provider-note.txt'))
const streamed = []
for await (const chunk of await fs.streamText(fileTarget)) streamed.push(chunk)
check('fs.streamText iterates', streamed.join('') === 'beta\n', JSON.stringify(streamed))

// subprocess: spawn, capture, exit code
const handle = subprocess.spawn({
  argv: ['/bin/sh', '-c', 'echo out-$((3*14)); echo err-line >&2; exit 7'],
  cwd: WORKSPACE, graceMs: 3000,
  stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
})
let out = ''
let err = ''
handle.stdout?.on('data', chunk => { out += chunk.toString() })
handle.stderr?.on('data', chunk => { err += chunk.toString() })
const result = await handle.done
check('subprocess.spawn exit code', result.exitCode === 7, `exit=${result.exitCode}`)
check('subprocess stdout', out.includes('out-42'), JSON.stringify(out))
check('subprocess stderr', err.includes('err-line'), JSON.stringify(err))

// A missing candidate (a remote host without one of the terminal shells) must
// arrive as the official provider's typed miss so shell discovery skips it.
let missingExecutable
try {
  await subprocess.resolveExecutable('dsh-missing-shell-xyz')
} catch (error) {
  missingExecutable = error
}
check('missing executable keeps its typed provider error', missingExecutable?.name === 'SubprocessExecutableNotFoundError', `${missingExecutable?.name}: ${missingExecutable?.message}`)

// terminal: PTY through the official runtime
const terminal = await subprocess.spawnTerminal({
  argv: ['/bin/sh'], cwd: WORKSPACE, graceMs: 3000,
  terminalType: 'xterm-256color', rows: 24, cols: 80,
})
let tty = ''
terminal.output.on('data', chunk => { tty += chunk.toString() })
await terminal.write('echo tty-$((6*7))\n')
await new Promise(resolve => setTimeout(resolve, 1200))
check('spawnTerminal PTY output', tty.includes('tty-42'), JSON.stringify(tty.slice(-40)))
check('terminal inspectActivity', (await terminal.inspectActivity()).state !== undefined)
await terminal.terminate()

// sandbox: the daemon-side provider wraps argv
const confined = await ctx.get('sandbox').confine(['/bin/sh', '-c', 'true'], { mode: 'workspace-write', workspaceRoot: WORKSPACE })
check('sandbox.confine returns argv facts', Array.isArray(confined.argv) && confined.argv.length > 0, `enforcement=${confined.enforcement}`)

for (const fiber of fibers.reverse()) await fiber.dispose()
console.log(`${passed.filter(Boolean).length}/${passed.length} checks passed`)
process.exit(passed.every(Boolean) ? 0 : 1)
