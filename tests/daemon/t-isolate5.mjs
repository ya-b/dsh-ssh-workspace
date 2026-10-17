import { Context, Service } from '@deepseek-ai/cordis'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'

class InnerSandbox extends Service { constructor(c) { super(c, 'sandbox') } }
class InnerProc extends Service { constructor(c) { super(c, 'subprocess') } }
class Consuming extends Service {
  static inject = ['subprocess', 'sandbox', 'sandboxPolicy']
  constructor(c) { super(c, 'shell'); console.log('  consuming sandboxPolicy mode:', c.sandboxPolicy.defaultMode) }
}
class Registry extends Service {
  constructor(ctx) { super(ctx, 'workspaceRuntime'); this.ctx = ctx }
  async open() {
    const carrier = this.ctx.plugin(function executionWorldRealm() {})
    let realm = carrier.ctx
    for (const name of ['ssh', 'fs', 'subprocess', 'sandbox', 'shell']) realm = realm.isolate(name)
    // Re-publish the host plane's bridged services inside the realm's own scope.
    const bridged = [['sandboxPolicy', this.ctx.get('sandboxPolicy', false)], ['sessionProjections', this.ctx.get('sessionProjections', false)]]
      .filter(([, value]) => value !== undefined)
    realm = realm.extend(Object.fromEntries(bridged))
    realm.provide('ssh', {})
    await realm.plugin(InnerSandbox)
    await realm.plugin(InnerProc)
    await realm.plugin(Consuming)
    return carrier
  }
}
const ctx = new Context()
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: '/tmp' })
await ctx.plugin(Registry)
await ctx.workspaceRuntime.open()
console.log('done')
