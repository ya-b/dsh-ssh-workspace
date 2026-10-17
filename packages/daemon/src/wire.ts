/** Input validation helpers for durable opId-scoped daemon operations. */

import { z } from 'zod'
import { spawnSchema } from './schemas.ts'

/** Durable resubmission key: client-generated, hex, stable across reconnects. */
export const opIdSchema = z.string().regex(/^[0-9a-f]{16,128}$/)

/** `process.prepare` request: spawn fields plus an optional durability key. */
export const prepareRequest = z.object({ opId: opIdSchema.optional() })

/** Return type of spawnSchema.parse with the refine removed for extension. */
export type SpawnParams = z.output<typeof spawnSchema>

type Base = Parameters<typeof spawnSchema.parse>[0]

/** `{...spawn fields, opId?}` validated by parsing the spawn body separately. */
export function parsePrepare(raw: unknown): { spawn: Base; opId: string | undefined } {
  if (typeof raw !== 'object' || raw === null) throw new Error('workspace daemon request must be an object')
  const { opId, ...spawn } = raw as Record<string, unknown>
  delete (spawn as Record<string, unknown>).__proto__
  const opIdClean = opId === undefined ? undefined : opIdSchema.parse(opId)
  const parsedSpawn = spawnSchema.parse(spawn) as Base
  return { spawn: parsedSpawn, opId: opIdClean }
}

/** Intent-or-version expected-state discriminator used by fs.write/fs.edit. */
export const expectedStateSchema = z.union([
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('createIfAbsent') }).strict(),
    z.object({ kind: z.literal('replaceIfVersion'), version: z.string() }).strict(),
  ]),
  z.object({ version: z.string() }).strict(),
])
