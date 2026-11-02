import { describe, expect, it } from 'vitest'
import type { BlockedOnTag } from '@/types/board'
import { BLOCKED_FALLBACK_COPY, blockedTagLabel, blockedTagSummary, blockerSendError, blockerSentToast } from '@/renderer/board/blocked-copy'

const open = (...numbers: number[]) => numbers.map((number) => ({ number, title: `title ${String(number)}`, url: `https://x/${String(number)}`, state: 'OPEN' }))

describe('blockedTagLabel', () => {
  it('names the first open blocker and counts the rest', () => {
    expect(blockedTagLabel({ kind: 'dependency', open: open(49, 48), shown: 2, total: 2 })).toBe('Waiting on #49 +1')
    expect(blockedTagLabel({ kind: 'dependency', open: open(49), shown: 1, total: 1 })).toBe('Waiting on #49')
  })

  it('shows a reason as written, and the fixed copy otherwise', () => {
    expect(blockedTagLabel({ kind: 'session', text: 'no currency column' })).toBe('no currency column')
    expect(blockedTagLabel({ kind: 'comment', text: 'decide 30 or 90' })).toBe('decide 30 or 90')
    expect(blockedTagLabel({ kind: 'unreadable', reason: 'boom' })).toBe('Blockers unknown')
    expect(blockedTagLabel({ kind: 'fallback' })).toBe('Reason on ticket')
  })
})

describe('blockedTagSummary', () => {
  const cases: readonly [BlockedOnTag, string][] = [
    [{ kind: 'dependency', open: open(49, 48), shown: 2, total: 2 }, 'Blocked by: #49 title 49, #48 title 48'],
    [{ kind: 'session', text: 'the reason' }, 'Blocked: the reason'],
    [{ kind: 'comment', text: 'the reason' }, 'Blocked: the reason'],
    [{ kind: 'unreadable', reason: 'GitHub reported an error' }, "Couldn't read this ticket's blocked-by links: GitHub reported an error."],
    [{ kind: 'fallback' }, BLOCKED_FALLBACK_COPY],
  ]

  it.each(cases)('summarises %j', (tag, copy) => {
    expect(blockedTagSummary(tag)).toBe(copy)
  })

  it('states the fallback as an agent marking it blocked, with its reason on the ticket', () => {
    expect(BLOCKED_FALLBACK_COPY).toBe('An agent marked this blocked. Its reason is on the ticket.')
  })
})

describe('blocker answer copy', () => {
  it('names the agent in the sent toast', () => {
    expect(blockerSentToast(51)).toBe('Sent your answer to #51\'s agent. It clears "Blocked" itself and carries on.')
  })

  it.each([
    ['unknown-session', 'That session has ended. Unblock #51 from its row once the board catches up.'],
    ['unreachable', "Couldn't reach the main process. Nothing was sent."],
    ['blocked-command', "That text is a command the session can't run here. Reword your answer."],
  ] as const)('explains %s', (error, copy) => {
    expect(blockerSendError(error, 51)).toBe(copy)
  })
})
