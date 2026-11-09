import { describe, expect, it } from 'vitest'
import { reconcileRepository } from '@/main/state/reconcile'
import { agent, denialsOf, entry, fetchOf, item, reconcile, session, sessionsOf, worktreeEntry, worktreesOf } from './reconcile-fixtures'

describe('reconcileRepository — status table', () => {
  it('trigger → waiting', () => {
    const state = reconcile([item({ matchedKeys: ['ready'] })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('waiting')
  })

  it('gate → gated', () => {
    const state = reconcile([item({ matchedKeys: ['blocked'] })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('gated')
  })

  it('terminal → terminal', () => {
    const state = reconcile([item({ matchedKeys: ['prOpened'] })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('terminal')
  })

  it('unstaged (markers only) → unstaged', () => {
    const state = reconcile([item({ matchedKeys: ['marker'] })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('unstaged')
  })

  it('in-flight, sessions unavailable → in-flight/sessions-unavailable', () => {
    const state = reconcile([item({ matchedKeys: ['inProgress'] })], { repoSessions: sessionsOf({ available: false, freshness: { unavailable: 'x' } }) })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('in-flight')
    expect(state.items[0]?.statusEvidence).toBe('sessions-unavailable')
  })

  it('in-flight, an active agent attached → in-flight/agent-active', () => {
    const state = reconcile([item({ matchedKeys: ['inProgress'] })], { repoSessions: sessionsOf({ agents: [agent({ activity: 'active' })] }) })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('in-flight')
    expect(state.items[0]?.statusEvidence).toBe('agent-active')
  })

  it('in-flight, no agent but an active implement session → in-flight/session-active (Decision 3)', () => {
    const state = reconcile([item({ matchedKeys: ['inProgress'] })], { repoSessions: sessionsOf({ sessions: [session({ activity: 'active' })] }) })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('in-flight')
    expect(state.items[0]?.statusEvidence).toBe('session-active')
  })

  it('in-flight, every attachment dormant → stalled/all-dormant', () => {
    const state = reconcile([item({ matchedKeys: ['inProgress'] })], { repoSessions: sessionsOf({ agents: [agent({ activity: 'dormant' })] }) })
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('stalled')
    expect(state.items[0]?.statusEvidence).toBe('all-dormant')
  })

  it('in-flight, no attachment at all → stalled/no-claimant', () => {
    const state = reconcile([item({ matchedKeys: ['inProgress'] })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.status).toBe('stalled')
    expect(state.items[0]?.statusEvidence).toBe('no-claimant')
  })
})

describe('reconcileRepository — waitingOn', () => {
  it('an unassigned trigger item reports waitingOn: nobody', () => {
    const state = reconcile([item({ matchedKeys: ['ready'], assignees: [] })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.waitingOn).toBe('nobody')
  })

  it('a session-required trigger item reports waitingOn: operator-session', () => {
    const body = ['---', '', '## Implementation Plan', '', "> **SESSION REQUIRED:** touches `.claude/**`"].join('\n')
    const state = reconcile([item({ matchedKeys: ['ready'], body })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.sessionRequired).toBe(true)
    expect(state.items[0]?.waitingOn).toBe('operator-session')
  })

  it('an ordinary assigned trigger item reports waitingOn: cockpit', () => {
    const state = reconcile([item({ matchedKeys: ['ready'] })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.waitingOn).toBe('cockpit')
  })
})

describe('reconcileRepository — linking', () => {
  it('an issue at pr opened whose pull request is absent reports linkReason: counterpart-not-open, never a merge-pending claim', () => {
    const state = reconcile([item({ matchedKeys: ['prOpened'] })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.linked).toBeNull()
    expect(state.items[0]?.linkReason).toBe('counterpart-not-open')
  })

  it('a pr opened issue whose closing pull request merged reports counterpart-merged, still unlinked', () => {
    const state = reconcile([item({ matchedKeys: ['prOpened'], closingPullRequests: [{ number: 669, state: 'MERGED' }] })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.linked).toBeNull()
    expect(state.items[0]?.linkReason).toBe('counterpart-merged')
  })

  it('a closed-unmerged, unread or empty closing pull request list stays counterpart-not-open', () => {
    for (const closingPullRequests of [[{ number: 669, state: 'CLOSED' as const }], null, []]) {
      const state = reconcile([item({ matchedKeys: ['prOpened'], closingPullRequests })])
      if (!state.ok) throw new Error('unreachable')
      expect(state.items[0]?.linkReason).toBe('counterpart-not-open')
    }
  })

  it('an open linked pull request in the sweep wins over a merged closing reference', () => {
    const state = reconcile([
      item({ number: 79, matchedKeys: ['prOpened'], closingPullRequests: [{ number: 150, state: 'MERGED' }] }),
      item({ kind: 'pull-request', number: 196, matchedKeys: ['readyForReview'], body: 'Closes #79' }),
    ])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items.find((i) => i.number === 79)?.linkReason).toBeNull()
  })

  it('a pull request with no closing keyword reports linkReason: no-closing-keyword', () => {
    const state = reconcile([item({ kind: 'pull-request', number: 196, matchedKeys: ['readyForReview'], body: 'no reference here' })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.linked).toBeNull()
    expect(state.items[0]?.linkReason).toBe('no-closing-keyword')
  })

  it('a pull request naming Closes #N links, and the issue links back', () => {
    const state = reconcile([
      item({ number: 79, matchedKeys: ['prOpened'] }),
      item({ kind: 'pull-request', number: 196, matchedKeys: ['readyForReview'], body: 'Closes #79' }),
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
  it('carries the pipeline fetch\'s vocabulary report onto RepositoryState, not just entry.config.vocabulary used internally', () => {
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

  it('carries pipelineFetch.disabled onto RepositoryState (#105)', () => {
    const fetch = fetchOf([])
    if (!fetch.ok) throw new Error('unreachable')
    const state = reconcileRepository({
      entry: entry(),
      pipelineFetch: { ...fetch, disabled: ['refreshBranch'] },
      itemsByNumberFetch: null,
      repoSessions: sessionsOf(),
      worktrees: worktreesOf(),
      denials: denialsOf(),
    })
    if (!state.ok) throw new Error('unreachable')
    expect(state.disabled).toEqual(['refreshBranch'])
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
    const state = reconcile([item({ matchedKeys: ['planApproved'], body })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.claimedFiles).toEqual(['src/lib/auth.ts'])
  })

  it('is null for an issue with no files fence at all — never an empty array', () => {
    const state = reconcile([item({ matchedKeys: ['planApproved'], body: '## Changes\nNo fence here.' })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.claimedFiles).toBeNull()
  })

  it('is always null for a pull request — its body is prose, never a claim fence', () => {
    const body = '```files\nsrc/lib/auth.ts\n```'
    const state = reconcile([item({ kind: 'pull-request', number: 196, matchedKeys: ['readyForReview'], body })])
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
      item({ kind: 'pull-request', number: 196, matchedKeys: ['readyForReview'], headRefOid: 'sha2', reviews, comments }),
    ])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.headRefOid).toBe('sha2')
    expect(state.items[0]?.reviews).toEqual(reviews)
    expect(state.items[0]?.comments).toEqual(comments)
    expect(state.items[0]?.reviewCycleCount).toBe(2)
  })

  it('is null for an issue, never a guessed count', () => {
    const state = reconcile([item({ matchedKeys: ['ready'] })])
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
    const state = reconcile([item({ matchedKeys: ['blocked'], blockers: { ok: false, reason: 'boom' }, blockerComments })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]).toMatchObject({ blockers: { ok: false, reason: 'boom' }, blockerComments })
  })
})

describe('reconcileRepository — workSessions', () => {
  it('lists a manual session in the item’s worktree without touching status evidence', () => {
    const manual = session({ sessionId: 'manual', role: 'other', roleEvidence: null, itemNumber: null, cwd: '/w/1/src', worktreePath: null, activity: 'active' })
    const state = reconcile([item({ number: 79, matchedKeys: ['inProgress'] })], {
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

describe('reconcileRepository — updatedAt/stageHistory', () => {
  it('copies updatedAt straight through', () => {
    const state = reconcile([item({ updatedAt: '2026-01-05T00:00:00Z' })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.updatedAt).toBe('2026-01-05T00:00:00Z')
  })

  it('resolves label names to keys, sorted oldest first', () => {
    const labelEvents = [
      { label: 'in progress', actor: 'b', at: '2026-01-02T00:00:00Z' },
      { label: 'ready', actor: 'a', at: '2026-01-01T00:00:00Z' },
    ]
    const state = reconcile([item({ labelEvents })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.stageHistory).toEqual([
      { key: 'ready', actor: 'a', at: '2026-01-01T00:00:00Z' },
      { key: 'inProgress', actor: 'b', at: '2026-01-02T00:00:00Z' },
    ])
  })

  it('drops an event whose label name matches no vocabulary label', () => {
    const labelEvents = [{ label: 'renamed-away', actor: 'a', at: '2026-01-01T00:00:00Z' }]
    const state = reconcile([item({ labelEvents })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.stageHistory).toEqual([])
  })

  it('drops marker and autoPlan events — they are not stages', () => {
    const labelEvents = [
      { label: 'claude', actor: 'a', at: '2026-01-01T00:00:00Z' },
      { label: 'auto plan', actor: 'a', at: '2026-01-01T00:00:01Z' },
    ]
    const state = reconcile([item({ labelEvents })])
    if (!state.ok) throw new Error('unreachable')
    expect(state.items[0]?.stageHistory).toEqual([])
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
