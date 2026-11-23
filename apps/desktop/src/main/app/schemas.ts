// Branded and shared pieces every action input is built from.
import { z } from 'zod'
import type { RepoId } from '@/utils/repos'
import type { SessionKey } from '@/types/hosting'
import type { LabelKey } from '@/utils/labels/vocabulary'

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== ''

export const repoId = z.custom<RepoId>(nonEmpty, { message: 'must be a non-empty repository id' })
export const sessionKey = z.custom<SessionKey>(nonEmpty, { message: 'must be a non-empty session key' })
export const expectedStage = z.custom<LabelKey>(nonEmpty).nullable()
export const positiveInt = z.int().positive()
export const noInput = z.undefined()
export const nonEmptyString = z.string().min(1)
