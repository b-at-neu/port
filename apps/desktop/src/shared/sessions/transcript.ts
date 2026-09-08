// Renderer-safe transcript shapes (#83). No import here may reach a Node
// builtin or the Agent SDK — `main/sessions/transcript-entries.ts` derives
// these from a session's or subagent's raw `.jsonl` records, and the
// renderer is the eventual consumer over IPC, so this file compiles under
// `typecheck:web` too (the same contract `shared/sessions/types.ts` already
// holds).

/** Caps a single rendered payload — the whole response is already bounded by
 *  `readTranscript`'s file-size cap; this protects one DOM node from a
 *  single oversized tool result or input. */
export const MAX_PAYLOAD_CHARS = 32_000

/** `omittedChars > 0` is the truncation signal a renderer foots with
 *  "N characters not shown" — never silently dropped. */
export interface Payload {
  readonly text: string
  readonly omittedChars: number
}

export type DiffSign = 'add' | 'del' | 'context'

/** `text` is the `structuredPatch` line verbatim, leading `+`/`-`/space
 *  included — `sign` is derived from that same leading character for
 *  styling, so the sign carries the meaning and colour stays redundant
 *  (ENGINEERING §5). */
export interface DiffLine {
  readonly sign: DiffSign
  readonly text: string
}

export interface DiffHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly DiffLine[]
}

export interface FileDiff {
  readonly path: string
  readonly isNewFile: boolean
  readonly additions: number
  readonly deletions: number
  readonly hunks: readonly DiffHunk[]
}

interface TranscriptEntryBase {
  readonly uuid: string
  readonly timestamp: string
}

export interface UserTextEntry extends TranscriptEntryBase {
  readonly type: 'user-text'
  readonly text: Payload
}

export interface AssistantTextEntry extends TranscriptEntryBase {
  readonly type: 'assistant-text'
  readonly text: Payload
}

export interface ThinkingEntry extends TranscriptEntryBase {
  readonly type: 'thinking'
  readonly text: Payload
}

export interface ToolResult {
  readonly isError: boolean
  readonly payload: Payload
}

/** The `tool_use` block and the `tool_result` block that carries its `id`
 *  collapse into one entry — an unpaired call (the result never arrived, or
 *  arrived past the read window) keeps `result: null` rather than being
 *  dropped. */
export interface ToolCallEntry extends TranscriptEntryBase {
  readonly type: 'tool-call'
  readonly name: string
  readonly headline: string
  readonly input: Payload
  readonly result: ToolResult | null
  readonly diff: FileDiff | null
}

/** Attachments and system notices — rendered, never dropped, since silently
 *  discarding a record misrepresents the transcript. */
export interface MetaEntry extends TranscriptEntryBase {
  readonly type: 'meta'
  readonly label: string
}

export type TranscriptEntry = UserTextEntry | AssistantTextEntry | ThinkingEntry | ToolCallEntry | MetaEntry

export interface TranscriptSource {
  readonly sessionId: string
  readonly agentId: string | null
  readonly path: string
  readonly sizeBytes: number
  /** Activity, never liveness (Decision 4, carried from #78) — no
   *  `running`/`alive`/`isLive`-shaped field belongs here. */
  readonly modifiedAt: string
  readonly recordCount: number
  readonly malformedLines: number
}

export type TranscriptFailureKind = 'invalid-id' | 'session-unresolved' | 'not-found' | 'too-large' | 'unreadable'

/**
 * Direction of failure: closed on the answer, open on reporting. No path
 * returns `entries: []` for a read that did not succeed — an empty
 * transcript is the one output an operator reads as "this agent did
 * nothing". A file whose lines partly fail to parse is the single partial
 * case: `ok: true`, with `malformedLines` counted and named rather than
 * dropped.
 */
export type TranscriptRead =
  | { readonly ok: true; readonly source: TranscriptSource; readonly entries: readonly TranscriptEntry[] }
  | { readonly ok: false; readonly kind: TranscriptFailureKind; readonly message: string; readonly path: string | null }
