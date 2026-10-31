// Pure content-block building — a string passes through untouched, so a send with no attachments keeps today's wire shape.
import type { ComposerAttachment } from '@/utils/hosting/attachments'
import type { ContentBlock } from '@/types/hosting'

function blockFor(attachment: ComposerAttachment): ContentBlock {
  switch (attachment.kind) {
    case 'image':
      return { type: 'image', source: { type: 'base64', media_type: attachment.mediaType, data: attachment.data } }
    case 'pdf':
      return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: attachment.data }, title: attachment.name }
    case 'text':
      return { type: 'document', source: { type: 'text', media_type: 'text/plain', data: attachment.text }, title: attachment.name }
  }
}

/** A string with no attachments; otherwise one block per attachment, then the `text` block when it is non-empty. */
export function buildUserContent(text: string, attachments: readonly ComposerAttachment[]): string | ContentBlock[] {
  if (attachments.length === 0) return text
  const blocks: ContentBlock[] = attachments.map(blockFor)
  if (text !== '') blocks.push({ type: 'text', text })
  return blocks
}
