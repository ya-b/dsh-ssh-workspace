import schema from '@deepseek-ai/schemastery'
const S = schema.object({ launchKind: schema.union(['node-script','executable']), helper: schema.string(), requestTimeoutMs: schema.number().default(30000) })
try { console.log('unknown keys →', JSON.stringify(S({ launchKind:'executable', helper:'x', daemonDir:'/tmp/d', zzz:1 }))) } catch (e) { console.log('threw:', e.message) }
