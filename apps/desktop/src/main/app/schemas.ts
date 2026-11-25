// Branded and shared pieces every action input is built from.
import { z } from 'zod'
import type { LabelKey } from '@/utils/labels/vocabulary'

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== ''

export { repoId, sessionKey } from '@/utils/schemas'
export const expectedStage = z.custom<LabelKey>(nonEmpty).nullable()
export const positiveInt = z.int().positive()
export const noInput = z.undefined()
export const nonEmptyString = z.string().min(1)
