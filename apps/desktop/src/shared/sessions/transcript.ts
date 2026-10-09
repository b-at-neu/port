// Renderer-safe transcript shapes. No import here may reach a Node builtin or the Agent SDK — `main/sessions/transcript-entries.ts` derives these from raw `.jsonl` records.

/** Caps a single rendered payload, protecting one DOM node from a single oversized tool result or input. */
export const MAX_PAYLOAD_CHARS = 32_000

/** `omittedChars > 0` is the truncation signal a renderer foots with "N characters not shown" — never silently dropped. */
export interface Payload {
  readonly text: string
  readonly omittedChars: number
}

export type DiffSign = 'add' | 'del' | 'context'

/** `text` is the `structuredPatch` line verbatim; `sign` is derived from the same leading character so colour stays redundant with it. */
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

/** The `tool_use` block and the matching `tool_result` collapse into one entry — an unpaired call keeps `result: null` rather than being dropped. */
export interface ToolCallEntry extends TranscriptEntryBase {
  readonly type: 'tool-call'
  readonly name: string
  readonly headline: string
  readonly input: Payload
  readonly result: ToolResult | null
  readonly diff: FileDiff | null
}

/** Attachments and system notices — rendered, never dropped. */
export interface MetaEntry extends TranscriptEntryBase {
  readonly type: 'meta'
  readonly label: string
}

export type TranscriptEntry = UserTextEntry | AssistantTextEntry | ThinkingEntry | ToolCallEntry | MetaEntry

/** A prior `appended` entry whose `tool-call` result arrived later. Only a `ToolCallEntry` is ever patched: every other kind is complete the moment it is derived. */
export interface EntryPatch {
  readonly index: number
  readonly entry: ToolCallEntry
}

export interface TranscriptSource {
  readonly sessionId: string
  readonly agentId: string | null
  readonly path: string
  readonly sizeBytes: number
  /** Activity, never liveness — no `running`/`alive`/`isLive`-shaped field belongs here. */
  readonly modifiedAt: string
  readonly recordCount: number
  readonly malformedLines: number
}

export type TranscriptFailureKind = 'invalid-id' | 'session-unresolved' | 'not-found' | 'too-large' | 'unreadable'

/** Fails closed on the answer, open on reporting. No path returns `entries: []` for a read that did not succeed; a partly-malformed file is `ok: true` with `malformedLines` counted. */
export type TranscriptRead =
  | { readonly ok: true; readonly source: TranscriptSource; readonly entries: readonly TranscriptEntry[] }
  | { readonly ok: false; readonly kind: TranscriptFailureKind; readonly message: string; readonly path: string | null }

/** `transcript:tail:open`'s response. `tailId` is an opaque token — the renderer never constructs or parses one, only holds it and hands it back. */
export type TranscriptTailOpen =
  | { readonly ok: true; readonly tailId: string; readonly source: TranscriptSource; readonly entries: readonly TranscriptEntry[] }
  | { readonly ok: false; readonly kind: TranscriptFailureKind; readonly message: string; readonly path: string | null }

/** `unknown-tail` is an expected answer after idle expiry, not a bug. `truncated` is a file smaller than the cursor's offset. Both re-open from the start, never reported as "no new messages". */
export type TranscriptTailFailureKind = TranscriptFailureKind | 'unknown-tail' | 'truncated'

/** `transcript:tail:poll`'s response. Nothing new returns empty `appended`/`patched`, never reported as finished. `hasMore` means this chunk hit `MAX_CHUNK_BYTES`, so the caller should poll again immediately. */
export type TranscriptTailPoll =
  | {
      readonly ok: true
      readonly source: TranscriptSource
      readonly appended: readonly TranscriptEntry[]
      readonly patched: readonly EntryPatch[]
      readonly hasMore: boolean
    }
  | { readonly ok: false; readonly kind: TranscriptTailFailureKind; readonly message: string; readonly path: string | null }
