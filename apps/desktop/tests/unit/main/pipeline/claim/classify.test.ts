import { describe, expect, it } from 'vitest'
import { mirrorVocabularyOf, resolveDisplayVocabulary } from '@/utils/labels/display'
import type { RepoId } from '@/utils/repos'
import { buildClaimRequest, classifyPreflight } from '@/main/pipeline/claim/classify'
import type { ClaimPreflight, ClaimVerdict } from '@/types/claim'

const MIRROR = mirrorVocabularyOf({ displayVocabulary: resolveDisplayVocabulary({}) })
const REPO_ID = 'repo-1' as unknown as RepoId

function preflightWith(overrides: Partial<ClaimPreflight>): ClaimPreflight {
  return {
    kind: 'issue',
    number: 93,
    title: 'Claim a ticket from the UI',
    url: 'https://github.com/o/r/issues/93',
    state: 'OPEN',
    labels: [],
    assignees: [],
    viewer: 'alice',
    blockers: { ok: true, open: [], shown: 0, total: 0 },
    readAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('classifyPreflight', () => {
  it('reports not-found for a null item', () => {
    expect(classifyPreflight({ item: null, mirror: MIRROR })).toEqual({ kind: 'not-found' })
  })

  it('reports not-an-issue for a pull request, before any label or assignee is read', () => {
    const item = preflightWith({ kind: 'pull-request' })
    expect(classifyPreflight({ item, mirror: MIRROR })).toEqual({ kind: 'not-an-issue' })
  })

  it('reports already-claimed when the port label is present', () => {
    const item = preflightWith({ labels: ['port', 'planning'] })
    const verdict = classifyPreflight({ item, mirror: MIRROR })
    expect(verdict).toEqual({ kind: 'already-claimed', markerName: 'port' })
  })

  it('reports claimable/unassigned for an item with no assignees', () => {
    const item = preflightWith({ assignees: [] })
    expect(classifyPreflight({ item, mirror: MIRROR })).toEqual({
      kind: 'claimable',
      assigneeSituation: 'unassigned',
      others: [],
      closed: false,
      blockers: item.blockers,
    })
  })

  it('reports claimable/mine when only the viewer is assigned', () => {
    const item = preflightWith({ assignees: ['alice'], viewer: 'alice' })
    expect(classifyPreflight({ item, mirror: MIRROR })).toEqual({
      kind: 'claimable',
      assigneeSituation: 'mine',
      others: [],
      closed: false,
      blockers: item.blockers,
    })
  })

  it('reports claimable/others, naming every non-viewer assignee, when someone else is assigned', () => {
    const item = preflightWith({ assignees: ['bob', 'alice', 'carol'], viewer: 'alice' })
    const verdict = classifyPreflight({ item, mirror: MIRROR })
    expect(verdict.kind).toBe('claimable')
    if (verdict.kind !== 'claimable') return
    expect(verdict.assigneeSituation).toBe('others')
    expect(verdict.others).toEqual(['bob', 'carol'])
  })

  it('reports closed: true for a claimable item that is not OPEN, without refusing it', () => {
    const item = preflightWith({ state: 'CLOSED' })
    const verdict = classifyPreflight({ item, mirror: MIRROR })
    expect(verdict).toMatchObject({ kind: 'claimable', closed: true })
  })

  it('passes the blockers reading through unchanged', () => {
    const blockers = { ok: false as const, reason: "couldn't read blockedBy" }
    const item = preflightWith({ blockers })
    const verdict = classifyPreflight({ item, mirror: MIRROR })
    expect(verdict).toMatchObject({ kind: 'claimable', blockers })
  })
})

function claimableVerdict(overrides: Partial<Extract<ClaimVerdict, { kind: 'claimable' }>> = {}): Extract<ClaimVerdict, { kind: 'claimable' }> {
  return { kind: 'claimable', assigneeSituation: 'unassigned', others: [], closed: false, blockers: { ok: true, open: [], shown: 0, total: 0 }, ...overrides }
}

describe('buildClaimRequest', () => {
  it('an unassigned item: tracks the issue, assigns the viewer, expects unassigned, plain action text', () => {
    const preflight = preflightWith({ assignees: [] })
    const request = buildClaimRequest({ preflight, verdict: claimableVerdict(), mirror: MIRROR, repoId: REPO_ID, repo: 'o/r', planGate: 'review' })
    expect(request.event).toEqual({ kind: 'track', autoPlan: false })
    expect(request.addAssignees).toEqual(['alice'])
    expect(request.removeAssignees).toEqual([])
    expect(request.assignees).toEqual({ kind: 'unassigned' })
    expect(request.action).toBe('work on #93')
    expect(request.kind).toBe('issue')
    expect(request.number).toBe(93)
  })

  it('auto-approve tracks the issue with autoPlan', () => {
    const preflight = preflightWith({ assignees: [] })
    const request = buildClaimRequest({ preflight, verdict: claimableVerdict(), mirror: MIRROR, repoId: REPO_ID, repo: 'o/r', planGate: 'auto' })
    expect(request.event).toEqual({ kind: 'track', autoPlan: true })
  })

  it('already mine: no assignee change, exactly-the-viewer precondition', () => {
    const preflight = preflightWith({ assignees: ['alice'], viewer: 'alice' })
    const verdict = claimableVerdict({ assigneeSituation: 'mine' })
    const request = buildClaimRequest({ preflight, verdict, mirror: MIRROR, repoId: REPO_ID, repo: 'o/r', planGate: 'review' })
    expect(request.addAssignees).toEqual([])
    expect(request.removeAssignees).toEqual([])
    expect(request.assignees).toEqual({ kind: 'exactly', logins: ['alice'] })
    expect(request.action).toBe('work on #93')
  })

  it('a take-over: adds the viewer, removes every other assignee, exactly-the-observed-set precondition, take-over action text', () => {
    const preflight = preflightWith({ assignees: ['bob'], viewer: 'alice' })
    const verdict = claimableVerdict({ assigneeSituation: 'others', others: ['bob'] })
    const request = buildClaimRequest({ preflight, verdict, mirror: MIRROR, repoId: REPO_ID, repo: 'o/r', planGate: 'review' })
    expect(request.addAssignees).toEqual(['alice'])
    expect(request.removeAssignees).toEqual(['bob'])
    expect(request.assignees).toEqual({ kind: 'exactly', logins: ['bob'] })
    expect(request.action).toBe('work on #93 (take over)')
  })
})
