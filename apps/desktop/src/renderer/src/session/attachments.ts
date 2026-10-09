// Classifies a dropped/pasted/picked `File` into a `ComposerAttachment` or a rejection reason — directly testable, the read itself is the one impure seam.
import { IMAGE_MEDIA_TYPES, MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_PDF_BYTES, MAX_TEXT_BYTES, MAX_TOTAL_BYTES } from '../../../shared/hosting/attachments'
import type { ComposerAttachment, ImageMediaType } from '../../../shared/hosting/attachments'
import {
  oversizedImageNotice,
  oversizedPdfNotice,
  oversizedTextNotice,
  TOO_MANY_ATTACHMENTS_NOTICE,
  TOTAL_TOO_LARGE_NOTICE,
  unreadableFileNotice,
  unsupportedFileNotice,
} from './composer-copy'

export interface FileLike {
  readonly name: string
  readonly size: number
  readonly type: string
}

export type FileKind = 'image' | 'pdf' | 'text' | 'unsupported'

function isImageMediaType(type: string): type is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(type)
}

/** An image/video/audio MIME type outside the image allowlist is rejected outright; anything else is tried as text. */
export function classifyFileKind(file: FileLike): FileKind {
  if (isImageMediaType(file.type)) return 'image'
  if (file.type === 'application/pdf') return 'pdf'
  if (file.type.startsWith('image/') || file.type.startsWith('video/') || file.type.startsWith('audio/')) return 'unsupported'
  return 'text'
}

/** The size cap for `kind` — `null` for `unsupported`, which is never accepted at all. */
export function sizeLimitFor(kind: FileKind): number | null {
  switch (kind) {
    case 'image':
      return MAX_IMAGE_BYTES
    case 'pdf':
      return MAX_PDF_BYTES
    case 'text':
      return MAX_TEXT_BYTES
    case 'unsupported':
      return null
  }
}

/** Whether `file` is over its own kind's size cap — checked before any read,
 *  so an oversized file is never actually loaded into memory. */
export function sizeNotice(file: FileLike): string | null {
  const kind = classifyFileKind(file)
  const limit = sizeLimitFor(kind)
  if (limit === null || file.size <= limit) return null
  if (kind === 'image') return oversizedImageNotice(file.name)
  if (kind === 'pdf') return oversizedPdfNotice(file.name)
  return oversizedTextNotice(file.name)
}

export interface AttachmentBatchCheck {
  readonly accepted: readonly FileLike[]
  readonly rejected: readonly { readonly file: FileLike; readonly notice: string }[]
}

/** Checks a batch against the count and total-size caps, in offered order — never silently drops a rejection. */
export function checkBatchLimits(existingCount: number, existingTotalBytes: number, files: readonly FileLike[]): AttachmentBatchCheck {
  const accepted: FileLike[] = []
  const rejected: { file: FileLike; notice: string }[] = []
  let count = existingCount
  let total = existingTotalBytes

  for (const file of files) {
    if (count >= MAX_ATTACHMENTS) {
      rejected.push({ file, notice: TOO_MANY_ATTACHMENTS_NOTICE })
      continue
    }
    if (total + file.size > MAX_TOTAL_BYTES) {
      rejected.push({ file, notice: TOTAL_TOO_LARGE_NOTICE })
      continue
    }
    accepted.push(file)
    count += 1
    total += file.size
  }

  return { accepted, rejected }
}

export interface AttachmentReaderDeps {
  readonly readAsDataUrl: (file: File) => Promise<string>
  readonly readAsText: (file: File) => Promise<string>
}

/** A data URL's payload is everything after its first comma — exactly the
 *  base64 string `main`'s `ComposerAttachment` carries. */
function base64Of(dataUrl: string): string {
  const index = dataUrl.indexOf(',')
  return index === -1 ? '' : dataUrl.slice(index + 1)
}

export type ClassifyResult = { readonly ok: true; readonly attachment: ComposerAttachment } | { readonly ok: false; readonly notice: string }

/** Image/pdf as base64, text decoded strictly so a non-UTF-8 file reports unreadable rather than mojibake. */
export async function readAttachment(file: File, deps: AttachmentReaderDeps): Promise<ClassifyResult> {
  const kind = classifyFileKind(file)
  if (kind === 'unsupported') return { ok: false, notice: unsupportedFileNotice(file.name) }
  if (kind === 'image') {
    const dataUrl = await deps.readAsDataUrl(file)
    return { ok: true, attachment: { kind: 'image', name: file.name, mediaType: file.type as ImageMediaType, data: base64Of(dataUrl) } }
  }
  if (kind === 'pdf') {
    const dataUrl = await deps.readAsDataUrl(file)
    return { ok: true, attachment: { kind: 'pdf', name: file.name, data: base64Of(dataUrl) } }
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { ok: true, attachment: { kind: 'text', name: file.name, text } }
  } catch {
    return { ok: false, notice: unreadableFileNotice(file.name) }
  }
}
