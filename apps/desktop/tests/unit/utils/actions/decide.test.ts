import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { PullRequestCommentNode } from '@/types/github'
import type { ReconciledItem, StageLabel } from '@/types/state'
import { decisionPlan, decisionsFor, escalationOf, pickList, picksProblem, rebaseDecisionsOf, reviseNoteProblem } from '@/utils/actions/decide'

function item(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return {
    repoId: 'repo-a' as RepoId,
    repo: 'o/a',
    kind: 'pull-request',
    number: 300,
    title: 'a pull request',
    url: 'https://github.com/o/a/pull/300',
    assignees: ['op'],
    stage: 'gate',
    stages: [],
    stageAmbiguous: false,
    marked: true,
    autoPlan: false,
    status: 'gated',
    statusEvidence: null,
    waitingOn: null,
    sessionRequired: false,
    linked: null,
    linkReason: null,
    agents: [],
    sessions: [],
    worktrees: [],
    workSessions: [],
    state: 'OPEN',
    mergedAt: null,
    updatedAt: null,
    stageHistory: [],
    matchedKeys: [],
    sources: ['github'],
    claimedFiles: null,
    headRefOid: 'a'.repeat(40),
    mergeable: 'MERGEABLE',
    reviews: null,
    comments: null,
    reviewCycleCount: 0,
    checkRollup: null,
    planPresent: null,
    blockers: null,
    blockerComments: null,
    ...overrides,
  }
}

function stageLabel(key: StageLabel['key'], role: StageLabel['role']): StageLabel {
  return { key, name: key, role }
}

describe('decisionsFor — unblock', () => {
  it('is available on a pull request whose only role-bearing label is needsHuman', () => {
    const it1 = item({ stages: [stageLabel('needsHuman', 'gate')] })
    const result = decisionsFor({ item: it1, viewer: 'op', reviewCycleCap: 5, liveStage: false })
    expect(result.unblock).toEqual({ available: true, context: { target: 'pull-request', reason: null, cyclesUsed: 0, cap: 5, decisions: [] } })
  })

  it('carries the newest escalation reason', () => {
    const comments: readonly PullRequestCommentNode[] = [
      { body: '## Pipeline Escalation\nolder reason', createdAt: '2026-01-01T00:00:00Z' },
      { body: '## Pipeline Escalation\nnewer reason', createdAt: '2026-01-02T00:00:00Z' },
    ]
    const it1 = item({ stages: [stageLabel('needsHuman', 'gate')], comments })
    const result = decisionsFor({ item: it1, viewer: 'op', reviewCycleCap: 5, liveStage: false })
    expect(result.unblock).toEqual({ available: true, context: { target: 'pull-request', reason: 'newer reason', cyclesUsed: 0, cap: 5, decisions: [] } })
  })

  it('refuses rebase-decisions when the escalation carries D<n> blocks it cannot parse', () => {
    const comments: readonly PullRequestCommentNode[] = [{ body: '## Pipeline Escalation\n2 conflicts\n### D1 — `a.ts`\n### D2 — `b.ts`', createdAt: '2026-01-01T00:00:00Z' }]
    const it1 = item({ stages: [stageLabel('needsHuman', 'gate')], comments })
    expect(decisionsFor({ item: it1, viewer: 'op', reviewCycleCap: 5, liveStage: false }).unblock).toEqual({ available: false, reason: 'rebase-decisions' })
  })

  it('is available with the parsed decisions when every D<n> block parses', () => {
    const comments: readonly PullRequestCommentNode[] = [{ body: TWO_DECISIONS, createdAt: '2026-01-01T00:00:00Z' }]
    const it1 = item({ stages: [stageLabel('needsHuman', 'gate')], comments })
    const result = decisionsFor({ item: it1, viewer: 'op', reviewCycleCap: 5, liveStage: false })
    expect(result.unblock).toMatchObject({ available: true, context: { reason: '3 conflicts — 1 resolved automatically, 2 need a decision' } })
    if (result.unblock.available && 'decisions' in result.unblock.context) expect(result.unblock.context.decisions.map((d) => d.id)).toEqual(['D1', 'D2'])
  })

  it('raises the cap by one grant comment', () => {
    const comments: readonly PullRequestCommentNode[] = [
      { body: '## Gate cleared\nCleared by the operator in port: back to revision.\n\n### Cycle grant\nOne extra review cycle for this PR only; reviewCycleCap is unchanged.', createdAt: '2026-01-01T00:00:00Z' },
    ]
    const it1 = item({ stages: [stageLabel('needsHuman', 'gate')], comments })
    const result = decisionsFor({ item: it1, viewer: 'op', reviewCycleCap: 5, liveStage: false })
    expect(result.unblock).toEqual({ available: true, context: { target: 'pull-request', reason: null, cyclesUsed: 0, cap: 6, decisions: [] } })
  })

  it('is not-applicable on an issue at needsHuman, or with a second role-bearing label present', () => {
    const issue = item({ kind: 'issue', stages: [stageLabel('needsHuman', 'gate')] })
    expect(decisionsFor({ item: issue, viewer: 'op', reviewCycleCap: 5, liveStage: false }).unblock).toEqual({ available: false, reason: 'not-applicable' })

    const second = item({ stages: [stageLabel('needsHuman', 'gate'), stageLabel('refreshing', 'in-flight')] })
    expect(decisionsFor({ item: second, viewer: 'op', reviewCycleCap: 5, liveStage: false }).unblock).toEqual({ available: false, reason: 'not-applicable' })
  })
})

describe('decisionsFor — unblock on a blocked issue', () => {
  const blocked = (overrides: Partial<ReconciledItem> = {}) => item({ kind: 'issue', stages: [stageLabel('blocked', 'gate')], ...overrides })

  it('is available with an issue target when no stage session is live', () => {
    expect(decisionsFor({ item: blocked(), viewer: 'op', reviewCycleCap: 5, liveStage: false }).unblock).toEqual({
      available: true,
      context: { target: 'issue', reason: null, cyclesUsed: 0, cap: 0, decisions: [] },
    })
  })

  it('refuses agent-live while a stage session is live', () => {
    expect(decisionsFor({ item: blocked(), viewer: 'op', reviewCycleCap: 5, liveStage: true }).unblock).toEqual({ available: false, reason: 'agent-live' })
  })

  it('refuses not-owned for another assignee, ahead of agent-live', () => {
    expect(decisionsFor({ item: blocked({ assignees: ['other'] }), viewer: 'op', reviewCycleCap: 5, liveStage: true }).unblock).toEqual({ available: false, reason: 'not-owned' })
  })

  it('is not-applicable with a second role-bearing label present', () => {
    const second = blocked({ stages: [stageLabel('blocked', 'gate'), stageLabel('inProgress', 'in-flight')] })
    expect(decisionsFor({ item: second, viewer: 'op', reviewCycleCap: 5, liveStage: false }).unblock).toEqual({ available: false, reason: 'not-applicable' })
  })
})

describe('decisionsFor — revise', () => {
  it('is available on an approved pull request with a headRefOid', () => {
    const it1 = item({ stage: 'terminal', stages: [stageLabel('approved', 'terminal')], reviewCycleCount: 2 })
    expect(decisionsFor({ item: it1, viewer: 'op', reviewCycleCap: 5, liveStage: false }).revise).toEqual({
      available: true,
      context: { headRefOid: 'a'.repeat(40), cyclesUsed: 2, cap: 5 },
    })
  })

  it('refuses cycle-cap once cyclesUsed reaches the cap', () => {
    const it1 = item({ stage: 'terminal', stages: [stageLabel('approved', 'terminal')], reviewCycleCount: 5 })
    expect(decisionsFor({ item: it1, viewer: 'op', reviewCycleCap: 5, liveStage: false }).revise).toEqual({ available: false, reason: 'cycle-cap' })
  })

  it('is not-applicable with a null headRefOid', () => {
    const it1 = item({ stage: 'terminal', stages: [stageLabel('approved', 'terminal')], headRefOid: null })
    expect(decisionsFor({ item: it1, viewer: 'op', reviewCycleCap: 5, liveStage: false }).revise).toEqual({ available: false, reason: 'not-applicable' })
  })
})

describe('decisionsFor — ownership', () => {
  it('refuses viewer-unknown for both decisions', () => {
    const it1 = item({ stages: [stageLabel('needsHuman', 'gate')] })
    const result = decisionsFor({ item: it1, viewer: null, reviewCycleCap: 5, liveStage: false })
    expect(result.unblock).toEqual({ available: false, reason: 'viewer-unknown' })
    expect(result.revise).toEqual({ available: false, reason: 'viewer-unknown' })
  })

  it('refuses not-owned for an unassigned item — unlike actionsFor, there is no unassigned exception', () => {
    const it1 = item({ assignees: [], stages: [stageLabel('needsHuman', 'gate')] })
    expect(decisionsFor({ item: it1, viewer: 'op', reviewCycleCap: 5, liveStage: false }).unblock).toEqual({ available: false, reason: 'not-owned' })
  })

  it('refuses not-owned when assigned to someone else', () => {
    const it1 = item({ assignees: ['other'], stages: [stageLabel('needsHuman', 'gate')] })
    expect(decisionsFor({ item: it1, viewer: 'op', reviewCycleCap: 5, liveStage: false }).unblock).toEqual({ available: false, reason: 'not-owned' })
  })
})

describe('escalationOf', () => {
  it('returns null reason and no rebaseDecisions with no comments', () => {
    expect(escalationOf(null)).toEqual({ reason: null, rebaseDecisions: [] })
  })

  it('reads D<n> blocks from the newest escalation only', () => {
    const comments: readonly PullRequestCommentNode[] = [
      { body: '## Pipeline Escalation\nreason\n### D1 — `a.ts`', createdAt: '2026-01-01T00:00:00Z' },
      { body: '## Pipeline Escalation\nnewer reason', createdAt: '2026-01-02T00:00:00Z' },
    ]
    expect(escalationOf(comments)).toEqual({ reason: 'newer reason', rebaseDecisions: [] })
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
  it('unblock to revision', () => {
    const it1 = item({ stages: [stageLabel('needsHuman', 'gate')] })
    expect(decisionPlan('unblock', it1, 'revision', 'op')).toEqual({
      add: ['needsRevision'],
      remove: ['needsHuman'],
      expect: { present: ['needsHuman'], absent: [], assignees: { kind: 'exactly', logins: ['op'] } },
      action: 'unblock',
    })
  })

  it('unblock to review', () => {
    const it1 = item({ stages: [stageLabel('needsHuman', 'gate')] })
    expect(decisionPlan('unblock', it1, 'review', 'op').add).toEqual(['readyForReview'])
  })

  it('unblock to implementation', () => {
    const issue = item({ kind: 'issue', stages: [stageLabel('blocked', 'gate')] })
    expect(decisionPlan('unblock', issue, 'implementation', 'op')).toEqual({
      add: ['planApproved'],
      remove: ['blocked'],
      expect: { present: ['blocked'], absent: [], assignees: { kind: 'exactly', logins: ['op'] } },
      action: 'unblock',
    })
  })

  it('revise', () => {
    const it1 = item({ stage: 'terminal', stages: [stageLabel('approved', 'terminal')] })
    expect(decisionPlan('revise', it1, null, 'op')).toEqual({
      add: ['needsRevision'],
      remove: ['approved'],
      expect: { present: ['approved'], absent: [], assignees: { kind: 'exactly', logins: ['op'] } },
      action: 'revise',
    })
  })
})
