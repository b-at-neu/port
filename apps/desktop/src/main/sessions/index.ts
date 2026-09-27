// The public surface #79 imports — never `./sdk` or `./adapter` directly. A
// second reader spawning the SDK itself, or hand-rolling a second classifier,
// is exactly the drift this directory exists to prevent (ENGINEERING §1).
export type { ReadSessionStateParams } from './adapter'
export { readSessionState } from './adapter'

export type { RepoRef } from './classify'
export { PORT_STAGE_AGENTS } from './classify'

export type { CloseTailParams, OpenTailParams, PollTailParams, TailStore, TailStoreDeps } from './tail'
export { createTailStore, tailStore } from './tail'

export type { OpenTranscriptParams, OpenTranscriptResult, TranscriptCursor } from './transcript'
export { openTranscript } from './transcript'

// `main/relay/read.ts` imports the deriver through this barrel only, never
// `./transcript-entries` directly (ENGINEERING §1) — its own bounded tail
// read needs the pairing state `openTranscript` already builds this from,
// starting at an arbitrary offset rather than `openTranscript`'s own
// from-zero loop.
export type { DerivedChunk, Deriver } from './transcript-entries'
export { createDeriver } from './transcript-entries'

// `main/search/` imports the project index and path resolver through this
// barrel only, never `./locate` directly (ENGINEERING §1) -- one seam for
// both the sessions adapter and search to share.
export type { ProjectIndex } from './locate'
export { buildProjectIndex, defaultClaudeHome, resolveTranscriptPath } from './locate'

export type {
  Activity,
  AgentRecord,
  MetaProblem,
  MetaProblemKind,
  PortStageAgent,
  RoleEvidence,
  SessionFailureKind,
  SessionRecord,
  SessionRef,
  SessionRole,
  SessionScan,
} from '../../shared/sessions/types'
export { ACTIVE_WITHIN_MS, IDLE_WITHIN_MS } from '../../shared/sessions/types'

export type {
  AssistantTextEntry,
  DiffHunk,
  DiffLine,
  DiffSign,
  EntryPatch,
  FileDiff,
  MetaEntry,
  Payload,
  ThinkingEntry,
  ToolCallEntry,
  ToolResult,
  TranscriptEntry,
  TranscriptFailureKind,
  TranscriptRead,
  TranscriptSource,
  TranscriptTailFailureKind,
  TranscriptTailOpen,
  TranscriptTailPoll,
  UserTextEntry,
} from '../../shared/sessions/transcript'
export { MAX_PAYLOAD_CHARS } from '../../shared/sessions/transcript'
