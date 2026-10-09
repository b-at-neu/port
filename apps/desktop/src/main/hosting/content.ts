// Pure content-block building — a string passes through untouched, so a send with no attachments keeps today's wire shape.
import type { ComposerAttachment, ImageMediaType } from '../../shared/hosting/attachments'

/** The three Anthropic Messages API content-block shapes this app ever builds, never the SDK's own wider union. */
export type ContentBlock =
  | { readonly type: 'image'; readonly source: { readonly type: 'base64'; readonly media_type: ImageMediaType; readonly data: string } }
  | { readonly type: 'document'; readonly source: { readonly type: 'base64'; readonly media_type: 'application/pdf'; readonly data: string }; readonly title: string }
  | { readonly type: 'document'; readonly source: { readonly type: 'text'; readonly media_type: 'text/plain'; readonly data: string }; readonly title: string }
  | { readonly type: 'text'; readonly text: string }

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
