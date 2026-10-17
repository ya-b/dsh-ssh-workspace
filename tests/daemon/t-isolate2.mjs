import { Context, Service } from '@deepseek-ai/cordis'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
const ctx = new Context()
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: '/tmp' })
let realm = ctx
for (const name of ['ssh','fs','subprocess','sandbox','shell']) realm = realm.isolate(name)

class InnerSandbox extends Service {
  static inject = ['sandboxPolicy']
  constructor(c) { super(c, 'sandbox'); console.log('inner sandbox ok') }
}
class Consuming extends Service {
  static inject = ['subprocess', 'sandbox', 'sandboxPolicy']
  constructor(c) { super(c, 'shell'); console.log('consumer sandboxPolicy:', c.sandboxPolicy !== undefined) }
}
await realm.plugin(function carrier() {})
await realm.plugin(InnerSandbox)
class InnerProc extends Service { constructor(c) { super(c, 'subprocess') } }
await realm.plugin(InnerProc)
await realm.plugin(Consuming)
console.log('done')
