// Pure hand-back text rules, shared by `main/stage/handback.ts` and `renderer/board/needs-you.ts`
// so the two can no longer classify the same text two different ways.

/** Pinned byte-identical to `plugins/port/skills/pipeline/SKILL.md`'s own completion-handling prefixes, by the `desktop-dispatch` check. */
export const QUESTIONS_PREFIX = 'QUESTIONS FOR HUMAN:'
export const BLOCKED_PREFIX = 'BLOCKED:'
export const HANDBACK_PREFIX = 'HANDBACK:'

export type HandbackText =
  | { readonly kind: 'questions' }
  | { readonly kind: 'handback'; readonly token: string; readonly arg: string | null }
  | { readonly kind: 'blocked'; readonly line: string }
  | null

/** The text's last non-blank paragraph — paragraphs split on a blank line, since the prefix sits at the very end of the final message. */
export function lastParagraph(text: string): string {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim())
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const p = paragraphs[i]
    if (p !== undefined && p !== '') return p
  }
  return ''
}

/** A `BLOCKED:` line at line start, outside a fenced code block — a block is any line pair of ``` markers, closed or not. */
export function blockedLineOutsideFence(text: string): string | null {
  const lines = text.split('\n')
  let inFence = false
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      inFence = !inFence
      continue
    }
    if (!inFence && line.startsWith(BLOCKED_PREFIX)) return line
  }
  return null
}

/** The last non-blank line outside a fenced code block, when it is a `HANDBACK:` line: the first word after the prefix is the token, the rest is its argument. */
export function handbackLineOf(text: string): { readonly token: string; readonly arg: string | null } | null {
  let inFence = false
  let last: string | null = null
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (/^```/.test(trimmed)) {
      inFence = !inFence
      last = null
      continue
    }
    if (inFence || trimmed === '') continue
    last = trimmed
  }
  if (last === null || !last.startsWith(HANDBACK_PREFIX)) return null
  const rest = last.slice(HANDBACK_PREFIX.length).trim()
  if (rest === '') return null
  const space = rest.search(/\s/)
  if (space === -1) return { token: rest, arg: null }
  const arg = rest.slice(space).trim()
  return { token: rest.slice(0, space), arg: arg === '' ? null : arg }
}

const HANDBACK_TEXT_CAP = 120

/** Truncates hand-back text for a one-line display. */
export function capHandbackText(text: string): string {
  return text.length > HANDBACK_TEXT_CAP ? `${text.slice(0, HANDBACK_TEXT_CAP)}…` : text
}

/** A `BLOCKED:` line's reason: the prefix stripped, trimmed and capped. */
export function blockedReasonOf(line: string): string {
  return capHandbackText(line.slice(BLOCKED_PREFIX.length).trim())
}

/** Questions (last paragraph starts with the prefix) first, then a `HANDBACK:` last line, then a blocked line outside a fence, else `null`. */
export function classifyHandbackText(text: string): HandbackText {
  if (lastParagraph(text).startsWith(QUESTIONS_PREFIX)) return { kind: 'questions' }
  const handback = handbackLineOf(text)
  if (handback !== null) return { kind: 'handback', token: handback.token, arg: handback.arg }
  const blocked = blockedLineOutsideFence(text)
  if (blocked !== null) return { kind: 'blocked', line: blocked }
  return null
}
