// The bounded tail read over each stage agent's transcript (#107) — never
// the whole file: only the last `RELAY_TAIL_BYTES`, doubled once (capped at
// the file size) when that window holds no assistant text at all, so a
// poll's steady-state cost is a `stat` plus one small tail read per
// candidate rather than a full re-read of a growing transcript.
//
// Resolves every candidate through the `../sessions` barrel
// (`buildProjectIndex`/`resolveTranscriptPath`/`createDeriver`), never a deep
// `../sessions/*` import (ENGINEERING §1) — the same rail `main/search/
// query.ts` already follows for the same reason.
import { readLinesFrom, statPath } from '../platform/files'
import type { ReadLinesFromResult } from '../platform/files'
import { buildProjectIndex, defaultClaudeHome, resolveTranscriptPath } from '../sessions/locate'
import { createDeriver } from '../sessions/transcript-entries'
import type { ProjectIndex } from '../sessions/locate'
import { classifyFinalMessage, relayPayloadOf } from '../../shared/relay/classify'
import type { RelayPending, RelayScan } from '../../shared/relay/types'
import type { RelayKind } from '../../shared/relay/types'
import { agentLabel, sessionLabel } from '../../shared/sessions/label'
import type { AgentRecord, PortStageAgent, SessionScan } from '../../shared/sessions/types'

/** A candidate cap for one poll's pass — past it, every remaining candidate
 *  lands in `unreached` with its count reported, never silently skipped. */
export const MAX_RELAY_CANDIDATES = 40

/** A wall-clock budget for one poll's pass, checked with `now()` arithmetic
 *  only — no timer, the same rail `desktop-tick` already pins for `main/
 *  tick/`, restated here for `main/relay/` by `desktop-relay`'s own check. */
export const RELAY_BUDGET_MS = 750

/** The starting tail window — comfortably holds the final message of every
 *  transcript observed so far; a single doubling (capped at the file's own
 *  size) covers a final message sitting behind one large tool result. */
export const RELAY_TAIL_BYTES = 256 * 1024

export interface ReadRelayStateParams {
  readonly scan: SessionScan
  readonly claudeHome?: string
  readonly now?: () => Date
}

export interface RelayReader {
  readonly read: (params: ReadRelayStateParams) => Promise<RelayScan>
}

interface Candidate {
  readonly agent: AgentRecord
  readonly stage: PortStageAgent
  /** `null` when the transcript path itself never resolved — kept as a
   *  candidate rather than dropped, so it still increments `checked` and
   *  `unreached` in the main loop below, same as any other failure mode. */
  readonly path: string | null
}

/** `text` rides along with a `definite` verdict so the caller never has to
 *  re-read or re-derive the same tail a second time to parse its payload. */
type TailVerdict = { readonly kind: 'definite'; readonly verdict: RelayKind | 'completed'; readonly text: string } | { readonly kind: 'indeterminate' }

async function readOneTail(path: string, sizeBytes: number): Promise<TailVerdict> {
  let windowBytes = Math.min(RELAY_TAIL_BYTES, sizeBytes)
  let widened = false

  while (true) {
    const start = Math.max(0, sizeBytes - windowBytes)
    const chunk: ReadLinesFromResult = await readLinesFrom(path, start, { maxBytes: sizeBytes - start || 1 })
    if (!chunk.ok) return { kind: 'indeterminate' }

    const deriver = createDeriver({ cwd: null })
    const records: unknown[] = []
    for (const line of chunk.value.lines) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        records.push(JSON.parse(trimmed))
      } catch {
        // A partial line at the start of a tail window is expected — this
        // window widens or reports indeterminate, it never treats a parse
        // failure here as a malformed-line count the way a full read does.
      }
    }
    const { appended } = deriver.push(records)
    const lastAssistant = [...appended].reverse().find((entry) => entry.type === 'assistant-text')

    if (lastAssistant !== undefined) {
      const verdict = classifyFinalMessage(lastAssistant.text.text)
      // Defensive: `classifyFinalMessage` never actually returns
      // `'indeterminate'` (that verdict belongs to this function alone, for
      // a tail it never saw) — checked anyway rather than assumed, the same
      // rule `shared/gate/classify.ts`'s own comment states for a sibling
      // invariant.
      if (verdict === 'indeterminate') return { kind: 'indeterminate' }
      return { kind: 'definite', verdict, text: lastAssistant.text.text }
    }

    if (widened || windowBytes >= sizeBytes) return { kind: 'indeterminate' }
    widened = true
    windowBytes = Math.min(windowBytes * 2, sizeBytes)
  }
}

function candidatesOf(scan: Extract<SessionScan, { ok: true }>, index: ProjectIndex): readonly Candidate[] {
  const withPath = scan.agents.flatMap((agent) => {
    if (agent.stage === null || agent.repoId === null) return []
    const resolved = resolveTranscriptPath(agent.sessionId, agent.agentId, index)
    return [{ agent, stage: agent.stage, path: resolved.ok ? resolved.path : null }]
  })
  return withPath.slice().sort((a, b) => a.agent.idleMs - b.agent.idleMs)
}

/**
 * `createRelayReader().read` — every poll, never stored: the verdict is
 * recomputed from the transcript each time, cached only by the session
 * scan's own cadence (`main/state/watcher.ts` runs this right after
 * `refreshSessions`). Candidates are the session scan's own `agents` with
 * `stage !== null && repoId !== null`, sorted `idleMs` ascending so a budget
 * cutoff loses the coldest transcripts first — the same ladder `main/
 * search/query.ts` already uses. An operator's own `/port:implement` session
 * is deliberately not a candidate: this ticket is about dispatched stage
 * agents, never the session that dispatched them.
 */
export function createRelayReader(): RelayReader {
  return {
    async read({ scan, claudeHome, now }: ReadRelayStateParams): Promise<RelayScan> {
      const nowFn = now ?? (() => new Date())
      const start = nowFn().getTime()

      if (!scan.ok) return { ok: false, kind: scan.kind, message: scan.message, scannedAt: nowFn().toISOString() }

      const home = claudeHome ?? defaultClaudeHome()
      const indexResult = await buildProjectIndex(home)
      if (!indexResult.ok) return { ok: false, kind: indexResult.kind, message: indexResult.message, scannedAt: nowFn().toISOString() }

      const sessionById = new Map(scan.sessions.map((session) => [session.sessionId, session]))
      const candidates = candidatesOf(scan, indexResult.index)

      const pending: RelayPending[] = []
      let checked = 0
      let unreached = 0

      for (const candidate of candidates) {
        if (checked + unreached >= MAX_RELAY_CANDIDATES || nowFn().getTime() - start >= RELAY_BUDGET_MS) {
          unreached += 1
          continue
        }

        if (candidate.path === null) {
          checked += 1
          unreached += 1
          continue
        }

        const stat = await statPath(candidate.path)
        if (!stat.ok) {
          checked += 1
          unreached += 1
          continue
        }

        const tail = await readOneTail(candidate.path, stat.value.size)
        checked += 1
        if (tail.kind === 'indeterminate') {
          unreached += 1
          continue
        }
        if (tail.verdict === 'completed') continue

        const { agent } = candidate
        const session = sessionById.get(agent.sessionId)
        const base = {
          repoId: agent.repoId,
          number: agent.itemNumber,
          stage: candidate.stage,
          sessionId: agent.sessionId,
          agentId: agent.agentId,
          parentSessionLabel: session !== undefined ? sessionLabel(session) : agent.sessionId,
          agentLabel: agentLabel(agent),
          lastActivityAt: agent.lastActivityAt,
        }
        const payload = relayPayloadOf(tail.text, tail.verdict)
        pending.push(payload.kind === 'questions' ? { ...base, kind: 'questions', questions: payload.questions } : payload.kind === 'blocked' ? { ...base, kind: 'blocked', request: payload.request } : { ...base, kind: 'usage-limit' })
      }

      return { ok: true, pending, checked, unreached, scannedAt: nowFn().toISOString() }
    },
  }
}
