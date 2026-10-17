import { Context } from '@deepseek-ai/cordis'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
const ctx = new Context()
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: '/tmp' })
console.log('host get:', ctx.get('sandboxPolicy') !== undefined, 'direct:', ctx.sandboxPolicy !== undefined)
let realm = ctx
for (const name of ['ssh','fs','subprocess','sandbox','shell']) realm = realm.isolate(name)
const probePlugin = { name: 'probe', inject: ['sandboxPolicy'], apply(scope) { console.log('realm injected access:', scope.sandboxPolicy !== undefined) } }
try { await realm.plugin(probePlugin) } catch (e) { console.log('realm injected access threw:', e.message) }
console.log('realm get:', realm.get('sandboxPolicy') !== undefined)
