import { describe, expect, it } from 'vitest'
import { reconcileRepository } from '@/main/pipeline/board/reconcile'
import type { PipelineView } from '@/types/pipeline-state'
import type { Ticket } from '@/utils/pipeline/ticket'
import { NOW, queuedAt, ticketAt } from '../../../../support/tickets'
import { agent, denialsOf, entry, fetchOf, item, reconcile, session, sessionsOf, worktreeEntry, worktreesOf } from './reconcile-fixtures'

const PORT = ['port'] as const
const RUNNING = ['port', 'implementing'] as const

function viewOf(kind: 'issue' | 'pull-request', number: number, ticket: Ticket): PipelineView {
  return { kind: 'store', items: [{ kind, number, ticket }] }
}

describe('reconcileRepository — status table', () => {
  it('a marked item with no state label → waiting', () => {
    const state = reconcile([item({ matchedKeys: [...PORT] })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('waiting')
  })

  it('a needs-you item → gated', () => {
    const state = reconcile([item({ matchedKeys: ['port', 'needsYou'] })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('gated')
  })

  it('a done ticket → terminal', () => {
    const state = reconcile([item()], { view: viewOf('issue', 79, ticketAt('merge', { kind: 'done', at: NOW })) })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('terminal')
  })

  it('an item without the port marker → unstaged, no ticket', () => {
    const state = reconcile([item({ matchedKeys: [] })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('unstaged')
    expect(state.items[0]?.ticket).toBeNull()
  })

  it('in-flight, sessions unavailable → in-flight/sessions-unavailable', () => {
    const state = reconcile([item({ matchedKeys: [...RUNNING] })], { repoSessions: sessionsOf({ available: false, freshness: { unavailable: 'x' } }) })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('in-flight')
    expect(state.items[0]?.statusEvidence).toBe('sessions-unavailable')
  })

  it('in-flight, an active agent attached → in-flight/agent-active', () => {
    const state = reconcile([item({ matchedKeys: [...RUNNING] })], { repoSessions: sessionsOf({ agents: [agent({ activity: 'active' })] }) })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('in-flight')
    expect(state.items[0]?.statusEvidence).toBe('agent-active')
  })

  it('in-flight, no agent but an active implement session → in-flight/session-active (Decision 3)', () => {
    const state = reconcile([item({ matchedKeys: [...RUNNING] })], { repoSessions: sessionsOf({ sessions: [session({ activity: 'active' })] }) })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('in-flight')
    expect(state.items[0]?.statusEvidence).toBe('session-active')
  })

  it('in-flight, every attachment dormant → stalled/all-dormant', () => {
    const state = reconcile([item({ matchedKeys: [...RUNNING] })], { repoSessions: sessionsOf({ agents: [agent({ activity: 'dormant' })] }) })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('stalled')
    expect(state.items[0]?.statusEvidence).toBe('all-dormant')
  })

  it('in-flight, no attachment at all → stalled/no-claimant', () => {
    const state = reconcile([item({ matchedKeys: [...RUNNING] })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('stalled')
    expect(state.items[0]?.statusEvidence).toBe('no-claimant')
  })
})

describe('reconcileRepository — waitingOn', () => {
  it('an unassigned waiting item reports waitingOn: nobody', () => {
    const state = reconcile([item({ matchedKeys: [...PORT], assignees: [] })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.waitingOn).toBe('nobody')
  })

  it('a session-required waiting item reports waitingOn: operator-session', () => {
    const body = ['---', '', '## Implementation Plan', '', "> **SESSION REQUIRED:** touches `.claude/**`"].join('\n')
    const state = reconcile([item({ matchedKeys: [...PORT], body })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.sessionRequired).toBe(true)
    expect(state.items[0]?.waitingOn).toBe('operator-session')
  })

  it('an ordinary assigned waiting item reports waitingOn: cockpit', () => {
    const state = reconcile([item({ matchedKeys: [...PORT] })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.waitingOn).toBe('cockpit')
  })
})

describe('reconcileRepository — linking', () => {
  const reviewTicket = ticketAt('review', queuedAt())

  it('an issue whose ticket tracks a pull request that is absent reports linkReason: counterpart-not-open, never a merge-pending claim', () => {
    const state = reconcile([item()], { view: viewOf('issue', 79, reviewTicket) })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.linked).toBeNull()
    expect(state.items[0]?.linkReason).toBe('counterpart-not-open')
  })

  it('an issue whose closing pull request merged reports counterpart-merged, still unlinked', () => {
    const state = reconcile([item({ closingPullRequests: [{ number: 669, state: 'MERGED', headRefName: null }] })], { view: viewOf('issue', 79, reviewTicket) })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.linked).toBeNull()
    expect(state.items[0]?.linkReason).toBe('counterpart-merged')
  })

  it('a closed-unmerged, unread or empty closing pull request list stays counterpart-not-open', () => {
    for (const closingPullRequests of [[{ number: 669, state: 'CLOSED' as const, headRefName: null }], null, []]) {
      const state = reconcile([item({ closingPullRequests })], { view: viewOf('issue', 79, reviewTicket) })
      if (!state.ok) throw new Error('unreachable')
      expect(state.items[0]?.linkReason).toBe('counterpart-not-open')
    }
  })

  it('an issue whose ticket tracks no pull request reports no-closing-keyword', () => {
    const state = reconcile([item()])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.linkReason).toBe('no-closing-keyword')
  })

  it('an open linked pull request in the sweep wins over a merged closing reference', () => {
    const state = reconcile([
      item({ number: 79, closingPullRequests: [{ number: 150, state: 'MERGED', headRefName: null }] }),
      item({ kind: 'pull-request', number: 196, matchedKeys: ['port', 'reviewing'], body: 'Closes #79' }),
    ])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items.find((i) => i.number === 79)?.linkReason).toBeNull()
  })

  it('a pull request with no closing keyword reports linkReason: no-closing-keyword', () => {
    const state = reconcile([item({ kind: 'pull-request', number: 196, matchedKeys: ['port', 'reviewing'], body: 'no reference here' })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.linked).toBeNull()
    expect(state.items[0]?.linkReason).toBe('no-closing-keyword')
  })

  it('a pull request naming Closes #N links, and the issue links back', () => {
    const state = reconcile([
      item({ number: 79 }),
      item({ kind: 'pull-request', number: 196, matchedKeys: ['port', 'reviewing'], body: 'Closes #79' }),
    ])
    if (!state.ok) throw new Error('unreachable')
    const issue = state.items.find((i) => i.number === 79)
    const pr = state.items.find((i) => i.number === 196)
    expect(pr?.linked).toBe(79)
    expect(issue?.linked).toBe(196)
    expect(issue?.linkReason).toBeNull()
  })
})

describe('reconcileRepository — pass-through fields', () => {
  it('carries the pipeline fetch\'s vocabulary report onto RepositoryState, not just entry.config.displayVocabulary used internally', () => {
    const report = { verdict: 'partial' as const, present: [], missing: [], problems: [], repoLabels: { ok: true as const, names: [] } }
    const fetch = fetchOf([])
    if (!fetch.ok) throw new Error('unreachable')
    const state = reconcileRepository({
      entry: entry(),
      pipelineFetch: { ...fetch, vocabulary: report },
      itemsByNumberFetch: null,
      repoSessions: sessionsOf(),
      worktrees: worktreesOf(),
      denials: denialsOf(),
    })
    if (!state.ok) throw new Error('unreachable')
    expect(state.vocabulary).toEqual(report)
  })

  it('carries pipelineFetch.viewer and entry.config.modules.approvalGate onto RepositoryState (#94)', () => {
    const fetch = fetchOf([])
    if (!fetch.ok) throw new Error('unreachable')
    const state = reconcileRepository({
      entry: { ...entry(), config: { ...entry().config, modules: { approvalGate: false, release: true, scope: true } } },
      pipelineFetch: { ...fetch, viewer: 'op' },
      itemsByNumberFetch: null,
      repoSessions: sessionsOf(),
      worktrees: worktreesOf(),
      denials: denialsOf(),
    })
    if (!state.ok) throw new Error('unreachable')
    expect(state.viewer).toBe('op')
    expect(state.approvalGate).toBe(false)
  })

  it('carries a null viewer through unchanged, never a guess', () => {
    const fetch = fetchOf([])
    if (!fetch.ok) throw new Error('unreachable')
    const state = reconcileRepository({
      entry: entry(),
      pipelineFetch: { ...fetch, viewer: null },
      itemsByNumberFetch: null,
      repoSessions: sessionsOf(),
      worktrees: worktreesOf(),
      denials: denialsOf(),
    })
    if (!state.ok) throw new Error('unreachable')
    expect(state.viewer).toBeNull()
  })

  it('carries entry.config.concurrency onto RepositoryState (#106)', () => {
    const state = reconcileRepository({
      entry: { ...entry(), config: { ...entry().config, concurrency: { sharedFiles: ['data/labels.json'], overlapThreshold: 3 } } },
      pipelineFetch: fetchOf([]),
      itemsByNumberFetch: null,
      repoSessions: sessionsOf(),
      worktrees: worktreesOf(),
      denials: denialsOf(),
    })
    if (!state.ok) throw new Error('unreachable')
    expect(state.concurrency).toEqual({ sharedFiles: ['data/labels.json'], overlapThreshold: 3 })
  })
})

describe('reconcileRepository — claimedFiles (#106)', () => {
  it('parses an issue plan body\'s ```files fence', () => {
    const body = '## Changes\n\n```files\nsrc/lib/auth.ts — adds the check\n```'
    const state = reconcile([item({ body })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.claimedFiles).toEqual(['src/lib/auth.ts'])
  })

  it('is null for an issue with no files fence at all — never an empty array', () => {
    const state = reconcile([item({ body: '## Changes\nNo fence here.' })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.claimedFiles).toBeNull()
  })

  it('is always null for a pull request — its body is prose, never a claim fence', () => {
    const body = '```files\nsrc/lib/auth.ts\n```'
    const state = reconcile([item({ kind: 'pull-request', number: 196, matchedKeys: ['port', 'reviewing'], body })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.claimedFiles).toBeNull()
  })
})

describe('reconcileRepository — headRefOid/reviews/comments/reviewCycleCount (#108)', () => {
  it('copies headRefOid/reviews/comments through for a pull request, and computes reviewCycleCount', () => {
    const reviews = [
      { body: '## Code Review — Cycle 1 · needs revision', submittedAt: '2026-01-01T00:00:00Z', commitOid: 'sha1' },
      { body: '## Code Review — Cycle 2 · approved', submittedAt: '2026-01-02T00:00:00Z', commitOid: 'sha2' },
    ]
    const comments = [{ body: '## Gate cleared', createdAt: '2026-01-03T00:00:00Z' }]
    const state = reconcile([
      item({ kind: 'pull-request', number: 196, matchedKeys: ['port', 'reviewing'], headRefOid: 'sha2', reviews, comments }),
    ])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.headRefOid).toBe('sha2')
    expect(state.items[0]?.reviews).toEqual(reviews)
    expect(state.items[0]?.comments).toEqual(comments)
    expect(state.items[0]?.reviewCycleCount).toBe(2)
  })

  it('is null for an issue, never a guessed count', () => {
    const state = reconcile([item()])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.headRefOid).toBeNull()
    expect(state.items[0]?.reviews).toBeNull()
    expect(state.items[0]?.comments).toBeNull()
    expect(state.items[0]?.reviewCycleCount).toBeNull()
  })
})

describe('reconcileRepository — blockers/blockerComments', () => {
  it('copies both through verbatim, an unreadable read included', () => {
    const blockerComments = [{ body: 'why', createdAt: '2026-01-01T00:00:00Z', url: 'https://x/c' }]
    const state = reconcile([item({ matchedKeys: ['port', 'needsYou'], blockers: { ok: false, reason: 'boom' }, blockerComments })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]).toMatchObject({ blockers: { ok: false, reason: 'boom' }, blockerComments })
  })
})

describe('reconcileRepository — workSessions', () => {
  it('lists a manual session in the item’s worktree without touching status evidence', () => {
    const manual = session({ sessionId: 'manual', role: 'other', roleEvidence: null, itemNumber: null, cwd: '/w/1/src', worktreePath: null, activity: 'active' })
    const state = reconcile([item({ number: 79, matchedKeys: [...RUNNING] })], {
      repoSessions: sessionsOf({ sessions: [manual] }),
      worktrees: worktreesOf([worktreeEntry({ path: '/w/1', correlation: { number: 79, rung: 'branch-name' } })]),
    })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.workSessions.map((s) => [s.sessionId, s.match])).toEqual([['manual', 'worktree']])
    expect(state.items[0]?.status).toBe('stalled')
    expect(state.items[0]?.statusEvidence).toBe('no-claimant')
  })
})

describe('reconcileRepository — worktreeTotals (#80 Decision 6)', () => {
  it('null, never 0, when the worktree read itself failed', () => {
    const state = reconcile([item()], { worktrees: { ok: false, kind: 'not-found', message: 'no git', readAt: '2026-01-01T00:00:00Z' } })
    if (!state.ok) throw new Error('unreachable')
    expect(state.worktreeTotals).toBeNull()
  })

  it('registered counts every entry, attached counts what reached an item, uncorrelated counts the unresolved rung', () => {
    const state = reconcile([item({ number: 79 })], {
      worktrees: worktreesOf([
        worktreeEntry({ path: '/w/1', correlation: { number: 79, rung: 'branch-name' } }),
        worktreeEntry({ path: '/w/2', correlation: { number: 999, rung: 'branch-name' } }), // correlates to an orphan, not this item
        worktreeEntry({ path: '/w/3', correlation: null, unresolved: 'no-rung-matched' }),
      ]),
    })
    if (!state.ok) throw new Error('unreachable')
    expect(state.worktreeTotals).toEqual({ registered: 3, attached: 1, uncorrelated: 1 })
  })
})

describe('reconcileRepository — updatedAt', () => {
  it('copies updatedAt straight through', () => {
    const state = reconcile([item({ updatedAt: '2026-01-05T00:00:00Z' })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.updatedAt).toBe('2026-01-05T00:00:00Z')
  })
})

describe('reconcileRepository — failure paths', () => {
  it('a failed pipeline fetch never returns ok: true with an empty items array', () => {
    const state = reconcileRepository({
      entry: entry(),
      pipelineFetch: { ok: false, kind: 'network', message: 'boom', fetchedAt: '2026-01-01T00:00:00Z' },
      itemsByNumberFetch: null,
      repoSessions: sessionsOf(),
      worktrees: worktreesOf(),
      denials: denialsOf(),
    })
    expect(state.ok).toBe(false)
    if (state.ok) throw new Error('unreachable')
    expect(state.reason).toBe('github-unavailable')
    expect('items' in state).toBe(false)
  })
})
