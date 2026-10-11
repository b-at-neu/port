// Every string the transcript screen renders — pure, no DOM.
import type { TranscriptFailureKind, TranscriptSource, TranscriptTailFailureKind } from '../../../shared/sessions/transcript'

export function openFailureCopy(kind: TranscriptFailureKind, message: string, path: string | null): string {
  const p = path ?? ''
  switch (kind) {
    case 'not-found':
      return `No transcript file at ${p}. The session may have been deleted.`
    case 'session-unresolved':
      return "Couldn't locate this session's directory under your Claude projects folder."
    case 'too-large':
      return `This transcript is past the 64 MB Port will read. Open it directly: ${p}`
    case 'unreadable':
      return `Couldn't read ${p} — ${message}`
    case 'invalid-id':
      return "That session or agent id isn't a valid identifier."
  }
}

export type TailBannerKind = 'not-found' | 'unreadable' | 'too-large' | 'unreachable'

export function tailBannerKindFor(kind: TranscriptTailFailureKind): TailBannerKind {
  if (kind === 'not-found' || kind === 'unreadable' || kind === 'too-large') return kind
  return 'unreachable'
}

export function tailBannerCopy(kind: TailBannerKind, message: string, path: string | null): string {
  const p = path ?? ''
  switch (kind) {
    case 'not-found':
      return `The transcript file is gone — it may have been deleted. ${p}`
    case 'unreadable':
      return `Couldn't read ${p} — ${message}`
    case 'too-large':
      return `This transcript has grown past the 64 MB Port will read. Open it directly: ${p}`
    case 'unreachable':
      return 'Lost contact with the main process.'
  }
}

export const TRUNCATED_NOTE = 'This transcript was rewritten — reloaded from the start.'

function formatBytes(size: number): string {
  if (size < 1024) return `${String(size)} B`
  const kb = size / 1024
  if (kb < 1024) return `${String(Math.round(kb))} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

export function subtitleFor(source: TranscriptSource, entryCount: number): string {
  return [
    source.agentId !== null ? `agent-${source.agentId}` : source.sessionId,
    `${String(entryCount)} messages`,
    formatBytes(source.sizeBytes),
    `last change ${new Date(source.modifiedAt).toLocaleTimeString()}`,
  ].join(' · ')
}
