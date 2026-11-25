import { describe, expect, it } from 'vitest'
import { afterApply, afterPreflight, isClaimed, workOnToastId } from '@/renderer/claim/work-on'
import type { ClaimApplyResponse, ClaimPreflightResponse } from '@/types/claim'
import type { RepoId } from '@/utils/repos'

const REPO_ID = 'repo-1' as RepoId
const NOW = new Date('2026-01-01T12:00:00Z')

type Resolved = Extract<ClaimPreflightResponse, { kind: 'resolved' }>

function resolved(assigneeSituation: 'unassigned' | 'mine' | 'others', assignees: readonly string[]): Resolved {
  return {
    kind: 'resolved',
    preflight: { kind: 'issue', number: 101, title: 'Fix the thing', url: 'u', state: 'OPEN', labels: [], assignees, viewer: 'octocat', blockers: { ok: true, open: [], shown: 0, total: 0 }, readAt: 't' },
    verdict: { kind: 'claimable', assigneeSituation, others: assigneeSituation === 'others' ? assignees : [], closed: false, blockers: { ok: true, open: [], shown: 0, total: 0 } },
  }
}

const claimable = resolved('unassigned', []).verdict as Extract<Resolved['verdict'], { kind: 'claimable' }>
const refusal: Resolved = { ...resolved('unassigned', []), verdict: { kind: 'already-claimed', markerName: 'claude' } }

describe('afterPreflight', () => {
  it.each<readonly [string, ClaimPreflightResponse, string]>([
    ['a failed read', { kind: 'failed', message: 'offline.' }, 'stop'],
    ['an unresolved number', { kind: 'unresolved' }, 'stop'],
    ['a refusing verdict', refusal, 'stop'],
    ['an unassigned issue', resolved('unassigned', []), 'apply'],
    ['an issue already mine', resolved('mine', ['octocat']), 'apply'],
    ['an issue assigned to someone else', resolved('others', ['alice']), 'ask-take-over'],
  ])('routes %s to %s', (_name, response, kind) => {
    expect(afterPreflight('acme/widgets', 101, response).kind).toBe(kind)
  })

  it.each<readonly [string, ClaimPreflightResponse]>([
    ['a failed read', { kind: 'failed', message: 'offline.' }],
    ['a refusing verdict', refusal],
  ])('stops with an error toast for %s', (_name, response) => {
    expect(afterPreflight('acme/widgets', 101, response)).toMatchObject({ kind: 'stop', toast: { tone: 'error' } })
  })

  it.each([
    ['unassigned', [] as string[]],
    ['mine', ['octocat']],
    ['others', ['alice']],
  ] as const)('confirms the preflight assignees for %s', (situation, assignees) => {
    const step = afterPreflight('acme/widgets', 101, resolved(situation, assignees))
    if (step.kind === 'stop') throw new Error('expected a claimable step')
    expect(step.confirmedAssignees).toEqual(assignees)
  })
})

describe('afterApply and isClaimed', () => {
  const conflict = { kind: 'precondition-failed', expected: [], observed: ['x'], readAt: 't' } as const
  it.each([
    ['applied', { kind: 'write', outcome: { kind: 'applied', argv: [] } }, 'success', true],
    ['no-op', { kind: 'write', outcome: { kind: 'no-op' } }, 'success', true],
    ['mirror-failed', { kind: 'write', outcome: { kind: 'mirror-failed', mirror: { kind: 'write-failed', stderr: 'x' } } }, 'success', false],
    ['precondition-failed', { kind: 'write', outcome: { kind: 'precondition-failed', conflict } }, 'error', false],
    ['moved', { kind: 'moved', confirmed: [], current: ['bob'], readAt: '2026-01-01T09:30:00Z' }, 'error', false],
    ['refused', { kind: 'refused', verdict: { kind: 'not-found' } }, 'error', false],
    ['preflight-failed', { kind: 'preflight-failed', message: 'offline.' }, 'error', false],
  ] as unknown as ReadonlyArray<readonly [string, ClaimApplyResponse, 'success' | 'error', boolean]>)('treats %s as %s, claimed %s', (_name, response, tone, claimed) => {
    expect(isClaimed(response)).toBe(claimed)
    expect(afterApply({ repo: 'acme/widgets', number: 101, verdict: claimable, response, status: undefined, now: NOW }).tone).toBe(tone)
  })
})

describe('workOnToastId', () => {
  it('is one id per row', () => {
    expect(workOnToastId(REPO_ID, 101)).toBe('work-on:repo-1:101')
  })
})
