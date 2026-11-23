import { z } from 'zod'
import { IMAGE_MEDIA_TYPES, MAX_ATTACHMENTS } from '@/utils/hosting/attachments'

const nonEmpty = z.string().min(1)

export const startMode = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fresh') }),
  z.object({ kind: z.literal('resume'), sessionId: nonEmpty }),
  z.object({ kind: z.literal('resume-at'), sessionId: nonEmpty, messageUuid: nonEmpty, resumeDropsTurn: nonEmpty.nullable() }),
  z.object({ kind: z.literal('fork'), sessionId: nonEmpty }),
])

export const startTarget = z.discriminatedUnion('kind', [z.object({ kind: z.literal('folder'), folderId: nonEmpty, worktree: z.boolean() }), z.object({ kind: z.literal('transcript') })])

const attachmentName = z.string().min(1).max(255)

export const attachment = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), name: attachmentName, mediaType: z.enum(IMAGE_MEDIA_TYPES), data: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/) }),
  z.object({ kind: z.literal('pdf'), name: attachmentName, data: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/) }),
  z.object({ kind: z.literal('text'), name: attachmentName, text: z.string() }),
])

export const attachments = z.array(attachment).max(MAX_ATTACHMENTS).readonly()

export const planDecision = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('approve'), mode: z.enum(['default', 'acceptEdits']) }),
  z.object({ kind: z.literal('keep-planning'), feedback: z.string().min(1).max(2000) }),
])
