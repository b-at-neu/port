// The composer's attachment contract and limits, shared by the renderer and main so the two sides can never drift.
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number]

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_PDF_BYTES = 10 * 1024 * 1024
export const MAX_TEXT_BYTES = 256 * 1024

export const MAX_ATTACHMENTS = 10
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024

export const MAX_ATTACHMENT_NAME_LENGTH = 255

/** `data`/`text` are base64 or plain text respectively, never decoded again on the wire. */
export type ComposerAttachment =
  | { readonly kind: 'image'; readonly name: string; readonly mediaType: ImageMediaType; readonly data: string }
  | { readonly kind: 'pdf'; readonly name: string; readonly data: string }
  | { readonly kind: 'text'; readonly name: string; readonly text: string }
