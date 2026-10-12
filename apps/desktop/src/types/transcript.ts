import type { TranscriptTailOpen, TranscriptTailPoll } from '@/utils/sessions/transcript'

export type TailBannerKind = 'not-found' | 'unreadable' | 'too-large' | 'unreachable'

export interface TailStoreDeps {
  readonly tailOpen: (sessionId: string, agentId: string | null) => Promise<TranscriptTailOpen>
  readonly tailPoll: (tailId: string) => Promise<TranscriptTailPoll>
  readonly tailClose: (tailId: string) => Promise<unknown>
  readonly isHidden: () => boolean
  readonly onVisibilityChange: (listener: () => void) => () => void
}
