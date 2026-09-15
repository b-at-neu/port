import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '../labels/vocabulary'
import type { RepoId } from '../repos'
import { buildClaimRequest, classifyPreflight } from './classify'
import type { ClaimPreflight, ClaimVerdict } from './types'

const VOCABULARY = resolveVocabulary({})
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
    expect(classifyPreflight({ item: null, vocabulary: VOCABULARY })).toEqual({ kind: 'not-found' })
  })

  it('reports not-an-issue for a pull request, before any label or assignee is read', () => {
    const item = preflightWith({ kind: 'pull-request' })
    expect(classifyPreflight({ item, vocabulary: VOCABULARY })).toEqual({ kind: 'not-an-issue' })
  })

  it('reports already-claimed when the marker label is present', () => {
    const item = preflightWith({ labels: ['claude', 'planning'] })
    const verdict = classifyPreflight({ item, vocabulary: VOCABULARY })
    expect(verdict).toEqual({ kind: 'already-claimed', markerName: 'claude' })
  })

  it('reports claimable/unassigned for an item with no assignees', () => {
    const item = preflightWith({ assignees: [] })
    expect(classifyPreflight({ item, vocabulary: VOCABULARY })).toEqual({
      kind: 'claimable',
      assigneeSituation: 'unassigned',
      others: [],
      closed: false,
      blockers: item.blockers,
    })
  })

  it('reports claimable/mine when only the viewer is assigned', () => {
    const item = preflightWith({ assignees: ['alice'], viewer: 'alice' })
    expect(classifyPreflight({ item, vocabulary: VOCABULARY })).toEqual({
      kind: 'claimable',
      assigneeSituation: 'mine',
      others: [],
      closed: false,
      blockers: item.blockers,
    })
  })

  it('reports claimable/others, naming every non-viewer assignee, when someone else is assigned', () => {
    const item = preflightWith({ assignees: ['bob', 'alice', 'carol'], viewer: 'alice' })
    const verdict = classifyPreflight({ item, vocabulary: VOCABULARY })
    expect(verdict.kind).toBe('claimable')
    if (verdict.kind !== 'claimable') return
    expect(verdict.assigneeSituation).toBe('others')
    expect(verdict.others).toEqual(['bob', 'carol'])
  })

  it('reports closed: true for a claimable item that is not OPEN, without refusing it', () => {
    const item = preflightWith({ state: 'CLOSED' })
    const verdict = classifyPreflight({ item, vocabulary: VOCABULARY })
    expect(verdict).toMatchObject({ kind: 'claimable', closed: true })
  })

  it('passes the blockers reading through unchanged', () => {
    const blockers = { ok: false as const, reason: "couldn't read blockedBy" }
    const item = preflightWith({ blockers })
    const verdict = classifyPreflight({ item, vocabulary: VOCABULARY })
    expect(verdict).toMatchObject({ kind: 'claimable', blockers })
  })
})

function claimableVerdict(overrides: Partial<Extract<ClaimVerdict, { kind: 'claimable' }>> = {}): Extract<ClaimVerdict, { kind: 'claimable' }> {
  return { kind: 'claimable', assigneeSituation: 'unassigned', others: [], closed: false, blockers: { ok: true, open: [], shown: 0, total: 0 }, ...overrides }
}

describe('buildClaimRequest', () => {
  it('an unassigned item: adds marker+ready, assigns the viewer, expects unassigned, plain action text', () => {
    const preflight = preflightWith({ assignees: [] })
    const request = buildClaimRequest({ preflight, verdict: claimableVerdict(), vocabulary: VOCABULARY, repoId: REPO_ID, repo: 'o/r', planGate: 'review' })
    expect(request.add).toEqual(['marker', 'ready'])
    expect(request.remove).toEqual([])
    expect(request.addAssignees).toEqual(['alice'])
    expect(request.removeAssignees).toEqual([])
    expect(request.expect).toEqual({ present: [], absent: ['marker'], assignees: { kind: 'unassigned' } })
    expect(request.action).toBe('work on #93')
    expect(request.kind).toBe('issue')
    expect(request.number).toBe(93)
  })

  it('auto-approve adds autoPlan alongside marker+ready', () => {
    const preflight = preflightWith({ assignees: [] })
    const request = buildClaimRequest({ preflight, verdict: claimableVerdict(), vocabulary: VOCABULARY, repoId: REPO_ID, repo: 'o/r', planGate: 'auto' })
    expect(request.add).toEqual(['marker', 'ready', 'autoPlan'])
  })

  it('already mine: no assignee change, exactly-the-viewer precondition', () => {
    const preflight = preflightWith({ assignees: ['alice'], viewer: 'alice' })
    const verdict = claimableVerdict({ assigneeSituation: 'mine' })
    const request = buildClaimRequest({ preflight, verdict, vocabulary: VOCABULARY, repoId: REPO_ID, repo: 'o/r', planGate: 'review' })
    expect(request.addAssignees).toEqual([])
    expect(request.removeAssignees).toEqual([])
    expect(request.expect.assignees).toEqual({ kind: 'exactly', logins: ['alice'] })
    expect(request.action).toBe('work on #93')
  })

  it('a take-over: adds the viewer, removes every other assignee, exactly-the-observed-set precondition, take-over action text', () => {
    const preflight = preflightWith({ assignees: ['bob'], viewer: 'alice' })
    const verdict = claimableVerdict({ assigneeSituation: 'others', others: ['bob'] })
    const request = buildClaimRequest({ preflight, verdict, vocabulary: VOCABULARY, repoId: REPO_ID, repo: 'o/r', planGate: 'review' })
    expect(request.addAssignees).toEqual(['alice'])
    expect(request.removeAssignees).toEqual(['bob'])
    expect(request.expect.assignees).toEqual({ kind: 'exactly', logins: ['bob'] })
    expect(request.action).toBe('work on #93 (take over)')
  })

  it('expect.absent always names marker, regardless of assignee situation', () => {
    const preflight = preflightWith({ assignees: ['alice'] })
    const request = buildClaimRequest({ preflight, verdict: claimableVerdict({ assigneeSituation: 'mine' }), vocabulary: VOCABULARY, repoId: REPO_ID, repo: 'o/r', planGate: 'review' })
    expect(request.expect.absent).toEqual(['marker'])
  })
})
