// The Closes-keyword join and the SESSION REQUIRED slot detection (#79) —
// pure, no I/O. Both implement PIPELINE.md rules exactly: "slot plus form,
// never a body-wide substring search" for the marker, and "closing keyword
// immediately preceding #<n>" for the link.
import type { PipelineItemKind } from '../../shared/github/types'

const CLOSING_KEYWORDS = 'close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved'

/** `#0` is never a real issue/pull-request number in this pipeline — the
 *  same exclusion `main/local/correlate.ts` applies to its own rungs. A bare
 *  `#79` mention with no preceding closing keyword never links, and only the
 *  first closing-keyword match in the body wins (a second `Closes` further
 *  down never overrides it). */
export function closingReference(body: string): number | null {
  const pattern = new RegExp(`\\b(?:${CLOSING_KEYWORDS})\\s+#(\\d+)\\b`, 'i')
  const match = pattern.exec(body)
  const raw = match?.[1]
  if (raw === undefined) return null
  const number = Number(raw)
  return number > 0 ? number : null
}

/**
 * The canonical rendering, byte-for-byte the one PIPELINE.md → "The marker"
 * documents — `scripts/checks/desktop-state.mjs` pins this prefix against
 * that file so the two can never silently diverge. Exported as the one
 * source both `sessionRequiredAt` and the check read.
 */
export const SESSION_REQUIRED_PREFIX = '> **SESSION REQUIRED:** '

const SESSION_REQUIRED_LINE = new RegExp(`^${SESSION_REQUIRED_PREFIX.replace(/[*]/g, '\\*')}(.+)$`)

/** Exported so `main/actions/gate.ts` splits an issue body at the same
 *  heading `sessionRequiredMarkerAt` scans from — one definition of "where
 *  the plan starts", never a second copy re-typed in the gate dialog's
 *  composition root. */
export const IMPLEMENTATION_PLAN_HEADING = '## Implementation Plan'
const CLOSES_LINE = /^Closes #\d+\b/

/** The first non-empty line starting at `fromIdx` must hold the canonical
 *  rendering with a non-empty reason — anything else (absent, empty, inline
 *  code, the rendering repeated further down) is not a marker. Fails open
 *  toward "not session-required": a false positive here stalls an item
 *  forever and invisibly (a trigger label at rest looks like normal
 *  in-flight work), while a false negative costs one denied edit and a
 *  retry — the recoverable direction. Returns the reason text itself, so the
 *  plan gate can render *why*, never just a boolean. */
function slotMarkerReason(lines: readonly string[], fromIdx: number): string | null {
  for (let i = fromIdx; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) return null
    if (line.trim() === '') continue
    const match = SESSION_REQUIRED_LINE.exec(line)
    if (match === undefined || match === null) return null
    const reason = match[1]?.trim() ?? ''
    return reason !== '' ? reason : null
  }
  return null
}

/**
 * Issue slot: the first non-empty line directly under the `## Implementation
 * Plan` heading (the plan is appended below the human-authored ticket, so
 * the body's own first line is never the plan's). Pull request slot: the
 * first non-empty line after the `Closes #<n>` line. Absent slot → not
 * session-required, per the fail-open rule above. Returns the reason text
 * behind the marker, or `null` — the one slot detector both
 * `sessionRequiredAt` (the boolean the tick engine already needs) and the
 * plan gate (which renders the reason itself, #92) read.
 */
export function sessionRequiredMarkerAt(body: string, kind: PipelineItemKind): string | null {
  const lines = body.split(/\r?\n/)
  if (kind === 'issue') {
    const headingIdx = lines.findIndex((line) => line.trim() === IMPLEMENTATION_PLAN_HEADING)
    if (headingIdx === -1) return null
    return slotMarkerReason(lines, headingIdx + 1)
  }
  const closesIdx = lines.findIndex((line) => CLOSES_LINE.test(line.trim()))
  if (closesIdx === -1) return null
  return slotMarkerReason(lines, closesIdx + 1)
}

export function sessionRequiredAt(body: string, kind: PipelineItemKind): boolean {
  return sessionRequiredMarkerAt(body, kind) !== null
}
