import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { BlockedOn } from '@/types/board'
import type { BlockerRead, IssueCommentNode } from '@/types/github'
import type { StageEntry } from '@/types/state'
import { ticketIndex } from '@/utils/tickets/ticket'
import { blockedOnOf, blockedOnTag } from '@/renderer/board/blocked-on'
import { reconciledItem } from '../../../fixtures/board-state'
import { stageSession } from '../../../fixtures/stage-session'

const REPO = 'repo-a' as RepoId
const BLOCKED_AT = '2026-01-02T00:00:00Z'

const OPEN_BLOCKERS: BlockerRead = {
  ok: true,
  open: [
    { number: 49, title: 'Add tax region', url: 'https://x/49', state: 'OPEN' },
    { number: 48, title: 'Store line tax', url: 'https://x/48', state: 'OPEN' },
  ],
  shown: 2,
  total: 2,
}

function comment(createdAt: string, body: string): IssueCommentNode {
  return { body, createdAt, url: `https://x/c/${createdAt}` }
}

function blockedIssue(overrides: Parameters<typeof reconciledItem>[0] = {}) {
  const history: StageEntry[] = [{ key: 'blocked', actor: 'port-bot', at: BLOCKED_AT }]
  return reconciledItem({ number: 51, stage: 'gate', stages: [{ key: 'blocked', name: 'blocked', role: 'gate' }], matchedKeys: ['blocked'], stageHistory: history, ...overrides })
}

function derive(item: ReturnType<typeof reconciledItem>, stageKey: string | undefined, sessions: Parameters<typeof blockedOnOf>[0]['sessions'] = []) {
  const ticket = ticketIndex([item]).tickets[0]
  if (ticket === undefined) throw new Error('no ticket')
  return blockedOnOf({ ticket, stageKey, sessions, repoId: REPO })
}

const blockedSession = (text: string, startedAt?: string, key?: string) =>
  stageSession({ key, repoId: REPO, stage: { agent: 'impl', number: 51, kind: 'issue', trigger: 'planApproved' }, phase: 'ready', startedAt, lastResult: { subtype: 'success', isError: false, text, at: '2026-01-02T01:00:00Z' } })

describe('blockedOnOf', () => {
  it('is null for a row that is not blocked, even with open dependencies', () => {
    const item = reconciledItem({ blockers: OPEN_BLOCKERS })
    expect(derive(item, 'ready')).toBeNull()
  })

  it('is non-null for a blocked label with nothing else to say', () => {
    expect(derive(blockedIssue(), 'blocked')).toEqual({ dependencies: null, session: null, comment: null })
  })

  it('reads a live BLOCKED: session on a row whose label has not moved yet', () => {
    const item = reconciledItem({ number: 51 })
    const result = derive(item, 'inProgress', [blockedSession('Did work.\n\nBLOCKED: The ledger export has no currency column.')])
    expect(result?.session).toEqual({ text: 'The ledger export has no currency column.', sessionKey: 'hosted-51' })
  })

  it('ignores an ended session, an error result and a session on another ticket', () => {
    const item = blockedIssue()
    const ended = stageSession({ repoId: REPO, stage: { agent: 'impl', number: 51, kind: 'issue', trigger: 'planApproved' }, phase: 'ended', lastResult: { subtype: 'success', isError: false, text: 'BLOCKED: x', at: BLOCKED_AT } })
    const errored = stageSession({ repoId: REPO, stage: { agent: 'impl', number: 51, kind: 'issue', trigger: 'planApproved' }, phase: 'ready', lastResult: { subtype: 'error_during_execution', isError: true, text: 'BLOCKED: x', at: BLOCKED_AT } })
    const other = stageSession({ repoId: REPO, stage: { agent: 'impl', number: 99, kind: 'issue', trigger: 'planApproved' }, phase: 'ready', lastResult: { subtype: 'success', isError: false, text: 'BLOCKED: x', at: BLOCKED_AT } })
    expect(derive(item, 'blocked', [ended, errored, other])?.session).toBeNull()
  })

  it('takes the newest of two live sessions', () => {
    const older = blockedSession('BLOCKED: old reason', '2026-01-01T00:00:00Z', 'older')
    const newer = blockedSession('BLOCKED: new reason', '2026-01-01T05:00:00Z', 'newer')
    expect(derive(blockedIssue(), 'blocked', [newer, older])?.session).toMatchObject({ text: 'new reason', sessionKey: 'newer' })
  })

  it('caps a long session reason', () => {
    const result = derive(blockedIssue(), 'blocked', [blockedSession(`BLOCKED: ${'x'.repeat(300)}`)])
    expect(result?.session?.text).toBe(`${'x'.repeat(120)}…`)
  })

  it('carries the dependency read through verbatim', () => {
    expect(derive(blockedIssue({ blockers: OPEN_BLOCKERS }), 'blocked')?.dependencies).toBe(OPEN_BLOCKERS)
  })

  describe('the ticket comment', () => {
    const pick = (comments: readonly IssueCommentNode[] | null, overrides: Parameters<typeof reconciledItem>[0] = {}) => derive(blockedIssue({ blockerComments: comments, ...overrides }), 'blocked')?.comment

    it('is the newest comment at or before the latest blocked event', () => {
      const comments = [comment('2026-01-01T00:00:00Z', 'older'), comment('2026-01-01T23:59:00Z', 'the reason'), comment(BLOCKED_AT, 'at the event')]
      expect(pick(comments)).toEqual({ text: 'at the event', url: `https://x/c/${BLOCKED_AT}` })
      expect(pick(comments.slice(0, 2))?.text).toBe('the reason')
    })

    it('is none when every comment came after the event', () => {
      expect(pick([comment('2026-01-03T00:00:00Z', 'later chatter')])).toBeNull()
    })

    it('is none without a blocked event, never an unrelated comment', () => {
      expect(pick([comment('2026-01-01T00:00:00Z', 'something')], { stageHistory: [] })).toBeNull()
    })

    it('uses the latest of several blocked events', () => {
      const history: StageEntry[] = [
        { key: 'blocked', actor: 'a', at: '2026-01-01T00:00:00Z' },
        { key: 'inProgress', actor: 'a', at: '2026-01-01T12:00:00Z' },
        { key: 'blocked', actor: 'a', at: '2026-01-03T00:00:00Z' },
      ]
      expect(pick([comment('2026-01-01T00:00:00Z', 'first block'), comment('2026-01-02T00:00:00Z', 'second block')], { stageHistory: history })?.text).toBe('second block')
    })

    it('skips heading lines and blank lines to the first text line, and caps it', () => {
      expect(pick([comment('2026-01-01T00:00:00Z', "## Blocker\n\nThe retention period isn't in the plan.\nMore.")])?.text).toBe("The retention period isn't in the plan.")
      expect(pick([comment('2026-01-01T00:00:00Z', `${'y'.repeat(200)}`)])?.text).toBe(`${'y'.repeat(120)}…`)
    })

    it('is none for a heading-only comment, and when comments were not read', () => {
      expect(pick([comment('2026-01-01T00:00:00Z', '## Blocker\n### Detail')])).toBeNull()
      expect(pick(null)).toBeNull()
    })
  })
})

describe('blockedOnTag', () => {
  const held = (overrides: Partial<BlockedOn> = {}): BlockedOn => ({ dependencies: null, session: null, comment: null, ...overrides })
  const session = { text: 'agent reason', sessionKey: 'hosted-1' as never }
  const ticketComment = { text: 'ticket reason', url: 'https://x/c' }

  it('prefers an open dependency over everything else', () => {
    expect(blockedOnTag(held({ dependencies: OPEN_BLOCKERS, session, comment: ticketComment }))).toMatchObject({ kind: 'dependency', total: 2 })
  })

  it('falls to the session reason when no dependency is open', () => {
    const none: BlockerRead = { ok: true, open: [], shown: 0, total: 0 }
    expect(blockedOnTag(held({ dependencies: none, session, comment: ticketComment }))).toEqual({ kind: 'session', text: 'agent reason' })
  })

  it('falls to the ticket comment next', () => {
    expect(blockedOnTag(held({ comment: ticketComment }))).toEqual({ kind: 'comment', text: 'ticket reason' })
  })

  it('reports an unreadable dependency read before the generic fallback, but after a reason', () => {
    const unreadable: BlockerRead = { ok: false, reason: 'boom' }
    expect(blockedOnTag(held({ dependencies: unreadable }))).toEqual({ kind: 'unreadable', reason: 'boom' })
    expect(blockedOnTag(held({ dependencies: unreadable, comment: ticketComment }))).toMatchObject({ kind: 'comment' })
  })

  it('falls back when nothing is known', () => {
    expect(blockedOnTag(held())).toEqual({ kind: 'fallback' })
    expect(blockedOnTag(held({ dependencies: { ok: true, open: [], shown: 0, total: 0 } }))).toEqual({ kind: 'fallback' })
  })
})
