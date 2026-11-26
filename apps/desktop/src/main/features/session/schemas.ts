import { z } from 'zod'
import { IMAGE_MEDIA_TYPES, MAX_ATTACHMENT_NAME_LENGTH, MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_PDF_BYTES, MAX_TEXT_BYTES, MAX_TOTAL_BYTES } from '@/utils/hosting/attachments'
import type { ComposerAttachment } from '@/utils/hosting/attachments'
import { SESSION_TITLE_MAX } from '@/types/hosting'
import { sessionKey } from '@/main/app/schemas'

export const MAX_INVOKE_ARGS_CHARS = 8_000
export const MAX_TASK_ID_CHARS = 128

const nonEmpty = z.string().min(1)

export const startMode = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fresh') }),
  z.object({ kind: z.literal('resume'), sessionId: nonEmpty }),
  z.object({ kind: z.literal('resume-at'), sessionId: nonEmpty, messageUuid: nonEmpty, resumeDropsTurn: nonEmpty.nullable() }),
  z.object({ kind: z.literal('fork'), sessionId: nonEmpty }),
])

export const startTarget = z.discriminatedUnion('kind', [z.object({ kind: z.literal('folder'), folderId: nonEmpty, worktree: z.boolean() }), z.object({ kind: z.literal('transcript') })])

/** The byte count a base64 string already matching the attachment pattern decodes to. */
export function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return (data.length / 4) * 3 - padding
}

export function attachmentBytes(attachment: ComposerAttachment): number {
  return attachment.kind === 'text' ? Buffer.byteLength(attachment.text, 'utf8') : base64ByteLength(attachment.data)
}

function noControlCharacter(value: string): boolean {
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || codePoint === 0x7f) return false
  }
  return true
}

const attachmentName = z.string().min(1).max(MAX_ATTACHMENT_NAME_LENGTH).refine(noControlCharacter, { message: 'an attachment name has no control characters' })

const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/)

export const attachment = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), name: attachmentName, mediaType: z.enum(IMAGE_MEDIA_TYPES), data: base64 }).refine((value) => base64ByteLength(value.data) <= MAX_IMAGE_BYTES, { message: 'image too large' }),
  z.object({ kind: z.literal('pdf'), name: attachmentName, data: base64 }).refine((value) => base64ByteLength(value.data) <= MAX_PDF_BYTES, { message: 'pdf too large' }),
  z.object({ kind: z.literal('text'), name: attachmentName, text: z.string() }).refine((value) => Buffer.byteLength(value.text, 'utf8') <= MAX_TEXT_BYTES, { message: 'text too large' }),
])

export const attachments = z
  .array(attachment)
  .max(MAX_ATTACHMENTS)
  .refine((all) => all.reduce((total, item) => total + attachmentBytes(item), 0) <= MAX_TOTAL_BYTES, { message: 'attachments too large in total' })
  .readonly()

export const sendInput = z.object({ sessionKey, text: z.string(), attachments: attachments.optional() }).refine((value) => value.text !== '' || (value.attachments?.length ?? 0) > 0, { message: 'a message needs text or an attachment' })

export const renameTitle = z.string().trim().min(1).max(SESSION_TITLE_MAX)

export const planDecision = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('approve'), mode: z.enum(['default', 'acceptEdits']) }),
  z.object({ kind: z.literal('keep-planning'), feedback: z.string().min(1).max(2000) }),
])
