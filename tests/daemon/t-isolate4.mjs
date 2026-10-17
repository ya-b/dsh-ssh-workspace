import { Context, Service } from '@deepseek-ai/cordis'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
const ctx = new Context()
await ctx.plugin(SessionProjectionRegistry)
const p = await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: '/tmp' })
const root = ctx.root
console.log('root fiber store keys:', Object.keys(root.fiber?.store ?? {}))
console.log('plugin fiber store keys:', Object.keys(p.fiber?.store ?? {}))
console.log('ctx fiber store keys:', Object.keys(ctx.fiber?.store ?? {}))
console.log('p keys:', Object.keys(p).join(','))
