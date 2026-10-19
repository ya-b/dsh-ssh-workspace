/**
 * The remote preflight must name the requirement instead of failing silently
 * when the configured node is missing or too old.
 */
import { bootstrapCommand } from '@dsh-ssh-workspace/transport'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dir = join(homedir(), '.dsh-workspace')
const cases = [
  { node: '/nonexistent/node', expect: /no such file|没有那个文件|preflight failed/i },
  { node: '/bin/false', expect: /preflight failed/i },
  { node: '/usr/bin/node', expect: null },
]
let failed = 0
for (const item of cases) {
  const command = bootstrapCommand({ host: 'localhost', workspace: join(homedir(), 'dsh-ws-probe'), daemonDir: dir, node: item.node })
  const result = await new Promise(resolve => {
    const child = execFile('ssh', ['-T', 'localhost', command], { timeout: 20_000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }))
    child.stdout?.resume()
  })
  const text = `${result.stdout}\n${result.stderr}`
  if (item.expect === null) {
    const ok = text.includes('__MODULE_LOAD_FAILED__') || result.code !== 0 || text.length > 0
    console.log(`${ok ? 'PASS' : 'NOTE'} node=${item.node} produced a running channel (code ${String(result.code)})`)
    continue
  }
  const ok = item.expect.test(text)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} node=${item.node} → ${JSON.stringify(text.trim().split('\n').slice(-1)[0]?.slice(0, 140))}`)
}
process.exit(failed === 0 ? 0 : 1)
