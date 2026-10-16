// Pure hand-back text rules, shared by `main/stage/handback.ts` and `renderer/board/needs-you.ts`
// so the two can no longer classify the same text two different ways.

/** Pinned byte-identical to `plugins/port/skills/pipeline/SKILL.md`'s own completion-handling prefixes, by the `desktop-dispatch` check. */
export const QUESTIONS_PREFIX = 'QUESTIONS FOR HUMAN:'
export const BLOCKED_PREFIX = 'BLOCKED:'

export type HandbackText = { readonly kind: 'questions' } | { readonly kind: 'blocked'; readonly line: string } | null

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

/** Questions (last paragraph starts with the prefix) checked first, then a blocked line outside a fence, else `null`. */
export function classifyHandbackText(text: string): HandbackText {
  if (lastParagraph(text).startsWith(QUESTIONS_PREFIX)) return { kind: 'questions' }
  const blocked = blockedLineOutsideFence(text)
  if (blocked !== null) return { kind: 'blocked', line: blocked }
  return null
}
