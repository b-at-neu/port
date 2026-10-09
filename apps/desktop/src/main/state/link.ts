// Both implement PIPELINE.md rules exactly: "slot plus form, never a body-wide substring search" for the marker, "closing keyword immediately preceding #<n>" for the link.
import type { PipelineItemKind } from '../../shared/github/types'

const CLOSING_KEYWORDS = 'close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved'

/** `#0` is never a real issue/pull-request number here. A bare mention with no preceding closing keyword never links; only the first match in the body wins. */
export function closingReference(body: string): number | null {
  const pattern = new RegExp(`\\b(?:${CLOSING_KEYWORDS})\\s+#(\\d+)\\b`, 'i')
  const match = pattern.exec(body)
  const raw = match?.[1]
  if (raw === undefined) return null
  const number = Number(raw)
  return number > 0 ? number : null
}

/** Byte-for-byte the rendering PIPELINE.md → "The marker" documents; pinned against that file so the two can never silently diverge. */
export const SESSION_REQUIRED_PREFIX = '> **SESSION REQUIRED:** '

const SESSION_REQUIRED_LINE = new RegExp(`^${SESSION_REQUIRED_PREFIX.replace(/[*]/g, '\\*')}(.+)$`)

/** One definition of "where the plan starts", never a second copy re-typed in the gate dialog's composition root. */
export const IMPLEMENTATION_PLAN_HEADING = '## Implementation Plan'
const CLOSES_LINE = /^Closes #\d+\b/

/** Fails open toward "not session-required": a false positive stalls an item forever and invisibly, while a false negative costs one denied edit and a retry. */
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

/** Issue slot: first non-empty line under `## Implementation Plan`. Pull request slot: first non-empty line after `Closes #<n>`. Absent slot → not session-required. */
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
