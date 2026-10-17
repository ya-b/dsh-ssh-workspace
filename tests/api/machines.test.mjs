/**
 * B1 unit test: `~/.ssh/config` machine enumeration. Wildcard and negated
 * patterns name rules rather than machines and must stay hidden; `Include`
 * files (relative, `~/`, and absolute) must be followed, and a file listed
 * twice must be read once.
 * Usage: node tests/api/machines.test.mjs
 */
import { hostAliases } from '@dsh-ssh-workspace/api'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const passed = []
function check(name, ok, detail = '') {
  passed.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

const home = await mkdtemp(join(tmpdir(), 'dsh-ssh-config-'))
await mkdir(join(home, '.ssh', 'conf.d'), { recursive: true })
await mkdir(join(home, 'outside'), { recursive: true })
await writeFile(join(home, '.ssh', 'config'), [
  '# leading directives before any Host apply to everything',
  'User fallback',
  '',
  'Host build-01 build-02',
  '  HostName build.example.internal',
  '  User deploy',
  '',
  'Host *',
  '  ServerAliveInterval 30',
  '',
  'Host staging-*',
  '  User ops',
  '',
  'Host !secret-01 legacy',
  '  Port 2222',
  '',
  'Include conf.d/*.conf',
  'Include ~/outside/extra.conf',
  'Include conf.d/extra.conf',
  '',
].join('\n'))
await writeFile(join(home, '.ssh', 'conf.d', 'extra.conf'), 'Host included-relative\n  Port 2200\n')
await writeFile(join(home, 'outside', 'extra.conf'), 'Host included-home\n')
await writeFile(join(home, '.ssh', 'conf.d', 'second.conf'), 'Host included-glob\n')

const aliases = await hostAliases(home)
check('concrete aliases from a multi-name Host line are listed', aliases.includes('build-01') && aliases.includes('build-02'), aliases.join(','))
check('a wildcard rule is hidden', !aliases.includes('*'))
check('a glob rule is hidden', !aliases.some(alias => alias.includes('*')))
check('a negated pattern is hidden', !aliases.includes('!secret-01') && aliases.includes('legacy'))
check('relative Include is followed', aliases.includes('included-relative'))
check('glob Include is followed', aliases.includes('included-glob'))
check('~/ Include is followed', aliases.includes('included-home'))
check('a file included twice is read once', aliases.filter(alias => alias === 'included-relative').length === 1)
check('declaration order is preserved', aliases.indexOf('build-01') < aliases.indexOf('legacy'), aliases.join(','))
check('no stray tokens leak from directives', !aliases.some(alias => ['User', 'HostName', 'Port', 'fallback', 'deploy'].includes(alias)))

await rm(home, { recursive: true, force: true })
const failures = passed.filter(entry => !entry.ok)
console.log(`${passed.length - failures.length}/${passed.length} checks passed`)
process.exit(failures.length === 0 ? 0 : 1)
