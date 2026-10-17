import { Context, Service } from '@deepseek-ai/cordis'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'

function report(label, realm) {
  const shadowKey = Object.getOwnPropertySymbols(realm).find(s => String(s).includes('shadow'))
  const start = (realm[shadowKey] ?? realm).fiber
  const lines = [`${label}: start fiber=${start.name}`]
  let fiber = start
  let guard = 0
  while (fiber && guard++ < 12) {
    const has = fiber.store?.['sandboxPolicy'] !== undefined
    const inject = Object.keys(fiber.inject ?? {}).join('|')
    lines.push(`  fiber=${fiber.name} hasSandboxPolicy=${has} inject=[${inject}] isolated=${String(realm[Context.isolate]?.['sandboxPolicy'])}`)
    fiber = fiber.parent
  }
  console.log(lines.join('\n'))
}

const ctx = new Context()
await ctx.plugin(SessionProjectionRegistry)
const p = await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: '/tmp' })
console.log('provider fiber store keys:', Object.keys(p.store ?? {}), 'service registered in fiber:', p.ctx.fiber.name)
let direct = ctx
for (const n of ['ssh','fs','subprocess','sandbox','shell']) direct = direct.isolate(n)
report('realm-from-root', direct)

await ctx.plugin(function registry(ctx) {
  this.ctx.plugin(function carrier() {})
  const carrier = ctx.plugin(function c2() {})
  let realm = carrier.ctx
  for (const n of ['ssh','fs','subprocess','sandbox','shell']) realm = realm.isolate(n)
  report('realm-from-carrier', realm)
  return () => {}
})
