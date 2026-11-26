// Branded and shared pieces every action input is built from.
import { z } from 'zod'
import { gateSchema, queueReasonSchema, stageSchema } from '@/utils/pipeline/ticket'

export { repoId, sessionKey } from '@/utils/schemas'

const stageStatus = z.union([
  z.object({ kind: z.literal('queued'), reason: queueReasonSchema }),
  z.object({ kind: z.literal('waiting-on-you'), gate: gateSchema }),
  z.object({ kind: z.enum(['held', 'running', 'blocked', 'done']) }),
])

/** Where the client last saw the ticket — `null` for one that was untracked. An action refuses as `moved` when the ticket has left it. */
export const expectedView = z.object({ stage: stageSchema, status: stageStatus }).nullable()
export const positiveInt = z.int().positive()
export const noInput = z.undefined()
export const nonEmptyString = z.string().min(1)
