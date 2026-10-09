// Every string the composer's new input paths render, kept in one file the way `copy.ts` already does for the session view.
import { MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_PDF_BYTES, MAX_TEXT_BYTES, MAX_TOTAL_BYTES } from '../../../shared/hosting/attachments'

export const LOADING_COMMANDS = 'Loading commands…'
export const COMMANDS_UNAVAILABLE = 'Commands unavailable in this session'
export const NO_MATCHING_COMMANDS = 'No matching commands'

export const LOADING_FILES = 'Loading files…'
export const FILES_UNREADABLE = "Couldn't list files in this session's folder."
export const NO_MATCHING_FILES = 'No matching files'

export function filesTruncatedNote(limit: number): string {
  return `Showing the first ${limit.toLocaleString('en-US')} files`
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
}

function kilobytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KB`
}

export function unsupportedFileNotice(name: string): string {
  return `${name} isn't supported. Attach an image (PNG, JPEG, GIF, WebP), a PDF, or a text file.`
}

export function oversizedImageNotice(name: string): string {
  return `${name} is over ${megabytes(MAX_IMAGE_BYTES)}.`
}

export function oversizedPdfNotice(name: string): string {
  return `${name} is over ${megabytes(MAX_PDF_BYTES)}.`
}

export function oversizedTextNotice(name: string): string {
  return `${name} is over ${kilobytes(MAX_TEXT_BYTES)}.`
}

export function unreadableFileNotice(name: string): string {
  return `Couldn't read ${name}.`
}

export const TOO_MANY_ATTACHMENTS_NOTICE = `Only ${String(MAX_ATTACHMENTS)} attachments fit in one message.`
export const TOTAL_TOO_LARGE_NOTICE = `Attachments are over ${megabytes(MAX_TOTAL_BYTES)} in total.`

export const ATTACH_FILES_TOOLTIP = 'Attach files'
export const DROP_TO_ATTACH_HINT = 'Drop to attach'

export function removeAttachmentLabel(name: string): string {
  return `Remove ${name}`
}

export const AGENTS_DISCLOSURE_NOTE = 'Stage agents are started by the pipeline, never from here.'

export const PIPELINE_SEND_BLOCKED = "/port:pipeline runs in a terminal session, not in port. Start it with `claude` in the repository."
