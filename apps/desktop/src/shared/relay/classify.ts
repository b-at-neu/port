// Pure marker classification for a stage agent's final message (#107) — no
// filesystem, no SDK. `main/relay/read.ts` is the only orchestration layer,
// so every rule here is testable against a literal string.
//
// "Form, not substring" — the same lesson `SESSION REQUIRED` detection
// (#156) already learned the hard way: a marker counts only at the **start
// of a line**, never inside a fenced code block or an inline-code span, so a
// message that merely *discusses* a marker (this file's own comments, or a
// plan that quotes the convention) never misclassifies as pending. Anchored
// with a literal `^` per line, never a bare `text.includes(...)` against the
// whole message.
import type { RelayKind, RelayPayload, RelayQuestion, RelayVerdict } from './types'

/** The two literal markers a stage agent's final message ends with —
 *  `scripts/checks/desktop-relay.ts`'s own pin (guard 4) asserts both appear
 *  verbatim in `plugins/port/docs/RECOVERY.md`'s own "Escalation" section,
 *  both directions. */
export const RELAY_MARKERS: Readonly<Record<'questions' | 'blocked', string>> = {
  questions: 'QUESTIONS FOR HUMAN:',
  blocked: 'BLOCKED:',
}

/** Matched case-insensitively, anywhere in the text — never line-anchored,
 *  since the real phrasing ("You've hit your session limit · resets …")
 *  never starts a line. Checked **only** when neither marker above matched
 *  (`classifyFinalMessage`'s own order), and carries no payload — it is
 *  reported, never relayable (`pipeline/SKILL.md`'s own "Agent questions and
 *  blockers": the class that must not be redispatched). */
export const USAGE_LIMIT_PHRASE = 'session limit'

/** `N.` or `N)` followed by at least one non-space character — a numbered
 *  question line, never a bare ordinal mentioned in prose. */
const NUMBERED_LINE_RE = /^\s*\d+[.)]\s+\S/

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Every line of `text` that is eligible to *carry* a marker: not one of the
 * ``` ``` `` fence delimiters, not a line inside a fenced block, and with
 * every inline-code span (`` `...` ``) stripped first — a marker quoted
 * inside either never counts, since quoting a convention is not asserting it.
 */
function eligibleLines(text: string): { readonly line: string; readonly index: number }[] {
  const out: { readonly line: string; readonly index: number }[] = []
  let inFence = false
  text.split('\n').forEach((raw, index) => {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence
      return
    }
    if (inFence) return
    out.push({ line: raw.replace(/`[^`]*`/g, ''), index })
  })
  return out
}

/** The zero-based line index of the first eligible line starting with
 *  `marker`, or `null` when no eligible line does. */
function markerLineIndex(text: string, marker: string): number | null {
  const pattern = new RegExp(`^${escapeForRegExp(marker)}`)
  for (const { line, index } of eligibleLines(text)) {
    if (pattern.test(line)) return index
  }
  return null
}

/**
 * `questions` additionally requires at least one numbered line somewhere
 * after the marker line — a body that names the marker without ever posing
 * a numbered question classifies `completed`, never `questions` (the plan's
 * own example: this ticket's body discusses the marker, and must not
 * misclassify). Order: `questions` before `blocked` before the usage-limit
 * substring, checked only when neither marker matched; `indeterminate` is
 * never returned here — that verdict belongs to `main/relay/read.ts` alone,
 * for a tail this function never saw.
 */
export function classifyFinalMessage(text: string): RelayVerdict {
  const questionsAt = markerLineIndex(text, RELAY_MARKERS.questions)
  if (
    questionsAt !== null &&
    eligibleLines(text).some(({ line, index }) => index > questionsAt && NUMBERED_LINE_RE.test(line))
  ) {
    return 'questions'
  }

  const blockedAt = markerLineIndex(text, RELAY_MARKERS.blocked)
  if (blockedAt !== null) return 'blocked'

  if (text.toLowerCase().includes(USAGE_LIMIT_PHRASE)) return 'usage-limit'

  return 'completed'
}

function questionsPayloadOf(text: string): readonly RelayQuestion[] {
  const lines = text.split('\n')
  const at = markerLineIndex(text, RELAY_MARKERS.questions) ?? -1
  return lines
    .slice(at + 1)
    .filter((line) => NUMBERED_LINE_RE.test(line))
    .map((line, index): RelayQuestion => ({ index, text: line.replace(/^\s*\d+[.)]\s+/, '').trim() }))
}

function blockedPayloadOf(text: string): string {
  const lines = text.split('\n')
  const at = markerLineIndex(text, RELAY_MARKERS.blocked) ?? -1
  const firstLineRemainder = (lines[at] ?? '').slice(RELAY_MARKERS.blocked.length).trim()
  const rest = lines
    .slice(at + 1)
    .join('\n')
    .trim()
  return [firstLineRemainder, rest].filter((part) => part !== '').join('\n')
}

/**
 * Parses the payload a definite `RelayKind` verdict carries — called only
 * once `classifyFinalMessage` has already returned that same `kind`, so this
 * never has to re-decide whether the marker is present. `questions` → the
 * ordered numbered lines after the marker; `blocked` → everything after
 * `BLOCKED:` (the rest of its own line, then every following line) as one
 * request string; `usage-limit` → no payload at all.
 */
export function relayPayloadOf(text: string, kind: RelayKind): RelayPayload {
  if (kind === 'usage-limit') return { kind: 'usage-limit' }
  if (kind === 'questions') return { kind: 'questions', questions: questionsPayloadOf(text) }
  return { kind: 'blocked', request: blockedPayloadOf(text) }
}
