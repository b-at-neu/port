import { z } from 'zod'
import type { RepoId } from '@/utils/repos'
import type { SessionKey } from '@/types/hosting'

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== ''

export const repoId = z.custom<RepoId>(nonEmpty, { message: 'must be a non-empty repository id' })
export const sessionKey = z.custom<SessionKey>(nonEmpty, { message: 'must be a non-empty session key' })
