import { describe, expect, it } from 'vitest'
import type { PullRequestCommentNode } from '@/types/github'
import type { ReconciledItem } from '@/types/state'
import { decisionPlan, decisionsFor, escalationOf, pickList, picksProblem, rebaseDecisionsOf, reviseNoteProblem } from '@/utils/actions/decide'
import type { DecisionsForParams } from '@/utils/actions/decide'
import { ticketViewOf } from '@/utils/pipeline/stages'
import { reconciledItem } from '../../../support/board-snapshot'
import { queuedAt, ticketAt } from '../../../support/tickets'

const ESCALATION = ticketAt('review', { kind: 'waiting-on-you', gate: 'escalation', detail: '' })
const MERGE_GATE = ticketAt('merge', { kind: 'waiting-on-you', gate: 'merge', detail: '' })
const CHANGES_REQUESTED = ticketAt('revise', queuedAt('changes-requested'))
const BLOCKED = ticketAt('implement', { kind: 'blocked', on: [], reason: 'stuck' })

function item(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return reconciledItem({ kind: 'pull-request', number: 300, headRefOid: 'a'.repeat(40), mergeable: 'MERGEABLE', reviewCycleCount: 0, ...overrides })
}

type Ticket = ReturnType<typeof ticketAt>

function decide(ticket: Ticket | null, it1: ReconciledItem, overrides: Partial<DecisionsForParams> = {}) {
  return decisionsFor({ view: ticket === null ? null : ticketViewOf(ticket), item: it1, viewer: 'op', reviewCycleCap: 5, liveStage: false, ...overrides })
}

describe('decisionsFor — unblock', () => {
  it('is available on a pull request waiting on its escalation gate', () => {
    expect(decide(ESCALATION, item()).unblock).toEqual({ available: true, context: { target: 'pull-request', reason: null, cyclesUsed: 0, cap: 5, decisions: [], routes: ['review', 'revision'] } })
  })

  it.each([
    ['a sha-cap marker', 'sha-cap', ['revision']],
    ['a cycle-cap marker', 'cycle-cap', ['review', 'revision']],
  ])('offers the routes for %s', (_name, cause, routes) => {
    const comments: readonly PullRequestCommentNode[] = [{ body: `## Pipeline Escalation\nreason\n<!-- port:escalation ${cause} abc -->`, createdAt: '2026-01-01T00:00:00Z' }]
    expect(decide(ESCALATION, item({ comments })).unblock).toMatchObject({ available: true, context: { routes } })
  })

  it('carries the newest escalation reason', () => {
    const comments: readonly PullRequestCommentNode[] = [
      { body: '## Pipeline Escalation\nolder reason', createdAt: '2026-01-01T00:00:00Z' },
      { body: '## Pipeline Escalation\nnewer reason', createdAt: '2026-01-02T00:00:00Z' },
    ]
    expect(decide(ESCALATION, item({ comments })).unblock).toEqual({ available: true, context: { target: 'pull-request', reason: 'newer reason', cyclesUsed: 0, cap: 5, decisions: [], routes: ['review', 'revision'] } })
  })

  it('refuses rebase-decisions when the escalation carries D<n> blocks it cannot parse', () => {
    const comments: readonly PullRequestCommentNode[] = [{ body: '## Pipeline Escalation\n2 conflicts\n### D1 — `a.ts`\n### D2 — `b.ts`', createdAt: '2026-01-01T00:00:00Z' }]
    expect(decide(ESCALATION, item({ comments })).unblock).toEqual({ available: false, reason: 'rebase-decisions' })
  })

  it('is available with the parsed decisions when every D<n> block parses', () => {
    const comments: readonly PullRequestCommentNode[] = [{ body: TWO_DECISIONS, createdAt: '2026-01-01T00:00:00Z' }]
    const result = decide(ESCALATION, item({ comments }))
    expect(result.unblock).toMatchObject({ available: true, context: { reason: '3 conflicts — 1 resolved automatically, 2 need a decision', routes: ['revision'] } })
    if (result.unblock.available && 'decisions' in result.unblock.context) expect(result.unblock.context.decisions.map((d) => d.id)).toEqual(['D1', 'D2'])
  })

  it('raises the cap by one grant comment', () => {
    const comments: readonly PullRequestCommentNode[] = [
      { body: '## Gate cleared\nCleared by the operator in port: back to revision.\n\n### Cycle grant\nOne extra review cycle for this PR only; reviewCycleCap is unchanged.', createdAt: '2026-01-01T00:00:00Z' },
    ]
    expect(decide(ESCALATION, item({ comments })).unblock).toEqual({ available: true, context: { target: 'pull-request', reason: null, cyclesUsed: 0, cap: 6, decisions: [], routes: ['review', 'revision'] } })
  })

  it.each([
    ['an issue at an escalation gate', ESCALATION, { kind: 'issue' as const }],
    ['a pull request running', ticketAt('review', { kind: 'running', runId: 'run-1' }), {}],
    ['a pull request at the merge gate', MERGE_GATE, {}],
    ['an item with no ticket', null, {}],
  ])('is not-applicable on %s', (_name, ticket, overrides) => {
    expect(decide(ticket, item(overrides)).unblock).toEqual({ available: false, reason: 'not-applicable' })
  })
})

describe('decisionsFor — unblock on a blocked issue', () => {
  const blocked = (overrides: Partial<ReconciledItem> = {}) => item({ kind: 'issue', ...overrides })

  it('is available with an issue target when no stage session is live', () => {
    expect(decide(BLOCKED, blocked()).unblock).toEqual({
      available: true,
      context: { target: 'issue', reason: null, cyclesUsed: 0, cap: 0, decisions: [], routes: ['implementation'] },
    })
  })

  it('refuses agent-live while a stage session is live', () => {
    expect(decide(BLOCKED, blocked(), { liveStage: true }).unblock).toEqual({ available: false, reason: 'agent-live' })
  })

  it('refuses not-owned for another assignee, ahead of agent-live', () => {
    expect(decide(BLOCKED, blocked({ assignees: ['other'] }), { liveStage: true }).unblock).toEqual({ available: false, reason: 'not-owned' })
  })

  it('is not-applicable once the issue is no longer blocked', () => {
    expect(decide(ticketAt('implement', queuedAt()), blocked()).unblock).toEqual({ available: false, reason: 'not-applicable' })
  })
})

describe('decisionsFor — revise', () => {
  it('is available on a pull request at the merge gate with a headRefOid', () => {
    expect(decide(MERGE_GATE, item({ reviewCycleCount: 2 })).revise).toEqual({
      available: true,
      context: { headRefOid: 'a'.repeat(40), cyclesUsed: 2, cap: 5 },
    })
  })

  it('refuses cycle-cap once cyclesUsed reaches the cap', () => {
    expect(decide(MERGE_GATE, item({ reviewCycleCount: 5 })).revise).toEqual({ available: false, reason: 'cycle-cap' })
  })

  it('is not-applicable with a null headRefOid', () => {
    expect(decide(MERGE_GATE, item({ headRefOid: null })).revise).toEqual({ available: false, reason: 'not-applicable' })
  })

  it('is not-applicable away from the merge gate', () => {
    expect(decide(ESCALATION, item()).revise).toEqual({ available: false, reason: 'not-applicable' })
  })
})

describe('decisionsFor — ownership', () => {
  it('refuses viewer-unknown for every decision', () => {
    const result = decide(ESCALATION, item(), { viewer: null })
    expect(result.unblock).toEqual({ available: false, reason: 'viewer-unknown' })
    expect(result.revise).toEqual({ available: false, reason: 'viewer-unknown' })
    expect(result.grant).toEqual({ available: false, reason: 'viewer-unknown' })
  })

  it('refuses not-owned for an unassigned item — unlike actionsFor, there is no unassigned exception', () => {
    expect(decide(ESCALATION, item({ assignees: [] })).unblock).toEqual({ available: false, reason: 'not-owned' })
  })

  it('refuses not-owned when assigned to someone else', () => {
    expect(decide(ESCALATION, item({ assignees: ['other'] })).unblock).toEqual({ available: false, reason: 'not-owned' })
  })
})

describe('escalationOf', () => {
  it('returns null reason and cause and no rebaseDecisions with no comments', () => {
    expect(escalationOf(null)).toEqual({ reason: null, cause: null, rebaseDecisions: [] })
  })

  it('parses the cause from the marker line, and is null without one', () => {
    const marked: readonly PullRequestCommentNode[] = [{ body: '## Pipeline Escalation\nreason\n<!-- port:escalation sha-cap abc -->', createdAt: '2026-01-01T00:00:00Z' }]
    expect(escalationOf(marked).cause).toBe('sha-cap')
    const bare: readonly PullRequestCommentNode[] = [{ body: '## Pipeline Escalation\nsha-cap in prose', createdAt: '2026-01-01T00:00:00Z' }]
    expect(escalationOf(bare).cause).toBeNull()
  })

  it('reads D<n> blocks from the newest escalation only', () => {
    const comments: readonly PullRequestCommentNode[] = [
      { body: '## Pipeline Escalation\nreason\n### D1 — `a.ts`', createdAt: '2026-01-01T00:00:00Z' },
      { body: '## Pipeline Escalation\nnewer reason', createdAt: '2026-01-02T00:00:00Z' },
    ]
    expect(escalationOf(comments)).toEqual({ reason: 'newer reason', cause: null, rebaseDecisions: [] })
  })
})

const TWO_DECISIONS = [
  '## Pipeline Escalation',
  '3 conflicts — 1 resolved automatically, 2 need a decision',
  '',
  '### Auto-resolved (reapplied on the next attempt)',
  '- `pnpm-lock.yaml` — regenerated',
  '',
  '### D1 — `src/money.ts`',
  '**Ours:** half-up',
  '**Theirs:** half-even',
  '',
  '| Option | Keeps | Loses |',
  '| --- | --- | --- |',
  '| **A take ours** | half-up | half-even |',
  '| **B** take theirs | half-even | half-up |',
  '| C — keep both | a flag | one path |',
  '',
  '**Recommendation: B** — base ships half-even.',
  '',
  '### D2 — `src/format.ts`',
  '',
  '| Option | Keeps | Loses |',
  '| --- | --- | --- |',
  '| **A take ours** | one | two |',
  '| **B take theirs** | locale | decimals |',
].join('\n')

describe('rebaseDecisionsOf', () => {
  it('parses two decisions with their options, summaries and recommendations', () => {
    expect(rebaseDecisionsOf(TWO_DECISIONS)).toEqual([
      {
        id: 'D1',
        path: 'src/money.ts',
        summary: '**Ours:** half-up',
        options: [
          { letter: 'A', label: 'take ours' },
          { letter: 'B', label: 'take theirs' },
          { letter: 'C', label: 'keep both' },
        ],
        recommended: 'B',
      },
      expect.anything(),
    ])
  })

  it.each([
    ['a bold letter alone with its label in the same cell', '| **A take ours** | x | y |', 'take ours'],
    ['a bold letter followed by a bare label', '| **A** take ours | x | y |', 'take ours'],
    ['a bare letter, dash, and label', '| A — take ours | x | y |', 'take ours'],
  ])('reads %s', (_name, row, label) => {
    const body = `## Pipeline Escalation\nreason\n### D1 — \`a.ts\`\n| Option | Keeps | Loses |\n| --- | --- | --- |\n${row}\n| **B take theirs** | x | y |`
    const decisions = rebaseDecisionsOf(body)
    expect(decisions === 'unparseable' ? null : decisions[0]?.options[0]).toEqual({ letter: 'A', label })
  })

  it('leaves recommended null when the block names none, or one the options lack', () => {
    const none = '## Pipeline Escalation\nr\n### D1 — `a.ts`\n| h | h |\n| --- | --- |\n| **A x** | k |\n| **B y** | k |'
    const decisions = rebaseDecisionsOf(none)
    expect(decisions === 'unparseable' ? 'unparseable' : decisions[0]?.recommended).toBeNull()
    const offMenu = `${none}\n**Recommendation: Z** — nope`
    const again = rebaseDecisionsOf(offMenu)
    expect(again === 'unparseable' ? 'unparseable' : again[0]?.recommended).toBeNull()
  })

  it('gives a null summary when a block has only its table', () => {
    const decisions = rebaseDecisionsOf(TWO_DECISIONS)
    expect(decisions === 'unparseable' ? 'unparseable' : decisions[1]?.summary).toBeNull()
  })

  it.each([
    ['a missing path', '### D1 — no path here\n| h | h |\n| --- | --- |\n| **A x** | k |\n| **B y** | k |'],
    ['a single option', '### D1 — `a.ts`\n| h | h |\n| --- | --- |\n| **A x** | k |'],
    ['duplicate letters', '### D1 — `a.ts`\n| h | h |\n| --- | --- |\n| **A x** | k |\n| **A y** | k |'],
    ['an option row it cannot read', '### D1 — `a.ts`\n| h | h |\n| --- | --- |\n| **A x** | k |\n| take theirs | k |'],
    ['no options table at all', '### D1 — `a.ts`\nsome prose'],
    ['a repeated decision id', '### D1 — `a.ts`\n| h | h |\n| --- | --- |\n| **A x** | k |\n| **B y** | k |\n### D1 — `b.ts`\n| h | h |\n| --- | --- |\n| **A x** | k |\n| **B y** | k |'],
  ])('is unparseable with %s', (_name, blocks) => {
    expect(rebaseDecisionsOf(`## Pipeline Escalation\nreason\n${blocks}`)).toBe('unparseable')
  })

  it('returns no decisions for an escalation without D<n> blocks', () => {
    expect(rebaseDecisionsOf('## Pipeline Escalation\n5 review cycles reached the cap of 5')).toEqual([])
  })
})

describe('picksProblem', () => {
  const decisions = rebaseDecisionsOf(TWO_DECISIONS)
  if (decisions === 'unparseable') throw new Error('fixture escalation must parse')

  it('accepts exactly one offered pick per decision', () => {
    expect(
      picksProblem(decisions, [
        { id: 'D1', letter: 'B' },
        { id: 'D2', letter: 'A' },
      ]),
    ).toBeNull()
  })

  it.each([
    ['a missing decision', [{ id: 'D1', letter: 'B' }], 'missing D2'],
    ['an unknown id', [{ id: 'D1', letter: 'B' }, { id: 'D2', letter: 'A' }, { id: 'D3', letter: 'A' }], 'unknown D3'],
    ['a duplicate id', [{ id: 'D1', letter: 'B' }, { id: 'D1', letter: 'A' }, { id: 'D2', letter: 'A' }], 'duplicate D1'],
    ['a letter off the menu', [{ id: 'D1', letter: 'B' }, { id: 'D2', letter: 'C' }], 'off-menu D2'],
  ])('reports %s', (_name, picks, problem) => {
    expect(picksProblem(decisions, picks)).toBe(problem)
  })
})

describe('pickList', () => {
  it('lists chosen letters in decision order and skips undecided ones', () => {
    const decisions = rebaseDecisionsOf(TWO_DECISIONS)
    if (decisions === 'unparseable') throw new Error('fixture escalation must parse')
    expect(pickList(decisions, { D2: 'B' })).toEqual([{ id: 'D2', letter: 'B' }])
  })
})

describe('reviseNoteProblem', () => {
  const sha = 'a'.repeat(40)

  it('reports empty before too-long or only-sha', () => {
    expect(reviseNoteProblem('', sha)).toBe('empty')
    expect(reviseNoteProblem('   \n  ', sha)).toBe('empty')
  })

  it('reports too-long past the character ceiling', () => {
    expect(reviseNoteProblem('x'.repeat(10_001), sha)).toBe('too-long')
  })

  it('reports only-sha when every non-empty line names the SHA', () => {
    expect(reviseNoteProblem(sha, sha)).toBe('only-sha')
  })

  it('returns null for a genuine request', () => {
    expect(reviseNoteProblem('rename the --limit flag to --max', sha)).toBeNull()
  })
})

describe('decisionPlan', () => {
  it.each([
    ['unblock to revision', 'unblock', 'revision', { kind: 'unblock', route: 'revision' }],
    ['unblock to review', 'unblock', 'review', { kind: 'unblock', route: 'review' }],
    ['unblock to implementation', 'unblock', 'implementation', { kind: 'unblock', route: 'implementation' }],
    ['unblock with no route defaults to review', 'unblock', null, { kind: 'unblock', route: 'review' }],
    ['revise', 'revise', null, { kind: 'revise' }],
    ['grant', 'grant', null, { kind: 'grant' }],
  ] as const)('%s', (_name, decision, route, move) => {
    expect(decisionPlan(decision, route)).toEqual(move)
  })
})

describe('decisionsFor — grant', () => {
  const capped = (overrides: Partial<ReconciledItem> = {}) => item({ reviewCycleCount: 5, ...overrides })

  it('is available on a revision queued for changes at the cap, carrying the cycles used and the cap', () => {
    expect(decide(CHANGES_REQUESTED, capped()).grant).toEqual({ available: true, context: { cyclesUsed: 5, cap: 5 } })
  })

  it('is not-applicable below the cap', () => {
    expect(decide(CHANGES_REQUESTED, capped({ reviewCycleCount: 4 })).grant).toEqual({ available: false, reason: 'not-applicable' })
  })

  it('is not-applicable for a revision queued for any other reason', () => {
    expect(decide(ticketAt('revise', queuedAt('retry')), capped()).grant).toEqual({ available: false, reason: 'not-applicable' })
  })

  it('refuses agent-live while a stage session is live', () => {
    expect(decide(CHANGES_REQUESTED, capped(), { liveStage: true }).grant).toEqual({ available: false, reason: 'agent-live' })
  })

  it('refuses not-owned and viewer-unknown ahead of everything else', () => {
    expect(decide(CHANGES_REQUESTED, capped({ assignees: ['other'] })).grant).toEqual({ available: false, reason: 'not-owned' })
    expect(decide(CHANGES_REQUESTED, capped(), { viewer: null }).grant).toEqual({ available: false, reason: 'viewer-unknown' })
  })

  it('counts an earlier grant toward the effective cap', () => {
    const comments = [{ body: '## Gate cleared\n\n### Cycle grant\nOne extra review cycle for this PR only; reviewCycleCap is unchanged.', createdAt: '2026-01-01T00:00:00Z' }]
    expect(decide(CHANGES_REQUESTED, capped({ comments })).grant).toEqual({ available: false, reason: 'not-applicable' })
  })
})
