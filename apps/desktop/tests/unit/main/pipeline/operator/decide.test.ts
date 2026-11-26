import { describe, expect, it } from 'vitest'
import type { ItemDecisionRequest } from '@/types/actions'
import type { ReconciledItem, StageLabel } from '@/types/state'
import { applyItemDecision } from '@/main/pipeline/operator/decide'
import { readAuditLog } from '@/main/github/writes/audit'
import { isLabelAuditEntry } from '@/types/writes'
import { boardSnapshot as snapshotOf, reconciledItem, repositoryState } from '../../../../support/board-snapshot'
import { operatorRig, REPO_ID, type OperatorRigOptions } from '../../../../support/operator-rig'
import { ticketOf } from '../../../../support/tickets'

const stageLabel = (key: StageLabel['key'], role: StageLabel['role']): StageLabel => ({ key, name: key, role })
const comment = (body: string) => [{ body, createdAt: '2026-01-01T00:00:00Z' }]
const CYCLE_CAP = comment('## Pipeline Escalation\n5 review cycles reached the cap of 5 without merging.')

function item(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return reconciledItem({ repoId: REPO_ID, kind: 'pull-request', number: 300, stage: 'gate', stages: [stageLabel('needsHuman', 'gate')], status: 'gated', matchedKeys: ['needsHuman'], headRefOid: 'a'.repeat(40), mergeable: 'MERGEABLE', reviewCycleCount: 0, ...overrides })
}

/** A pull request waiting on a human, with its issue. */
const ESCALATED: OperatorRigOptions = {
  viewer: 'op',
  items: [
    { number: 51, labels: ['port'], assignees: ['op'] },
    { number: 300, kind: 'pull-request', labels: ['port', 'needs human'], assignees: ['op'], headRefName: '51-fix', headRefOid: 'a'.repeat(40) },
  ],
  tickets: [ticketOf({ repo: REPO_ID, ticket: 51, pr: { number: 300, approvedAt: null }, stage: 'review', status: { kind: 'waiting-on-you', gate: 'escalation', detail: '' } })],
}

const unblock = (overrides: Partial<ItemDecisionRequest> = {}): ItemDecisionRequest => ({ repoId: REPO_ID, number: 300, decision: 'unblock', expectedStage: 'needsHuman', route: 'revision', note: null, skipComment: false, picks: null, ...overrides })

async function decide(options: { readonly rig?: OperatorRigOptions; readonly item?: ReconciledItem; readonly request?: ItemDecisionRequest; readonly liveStage?: boolean; readonly reviewCycleCap?: number; readonly viewer?: string | null } = {}) {
  const rig = await operatorRig(options.rig ?? ESCALATED)
  const snapshot = snapshotOf([repositoryState([options.item ?? item()], { repoId: REPO_ID, reviewCycleCap: options.reviewCycleCap ?? 5, ...(options.viewer === undefined ? {} : { viewer: options.viewer }) })])
  const result = await applyItemDecision(rig.ctx, { request: options.request ?? unblock(), snapshot, entry: rig.entry, auditDir: rig.auditDir, scratchDir: rig.scratchDir, liveStage: options.liveStage ?? false })
  return { rig, result }
}

describe('applyItemDecision — refusals', () => {
  it.each([
    { name: 'moved when the item is gone from the snapshot', snapshot: snapshotOf([repositoryState([], { repoId: REPO_ID })]), request: unblock(), expected: { ok: false, reason: 'moved', expected: 'needs human', observed: 'no longer tracked' } },
    { name: 'moved when the current stage disagrees with expectedStage', snapshot: snapshotOf([repositoryState([item({ stages: [stageLabel('approved', 'terminal')], stage: 'terminal' })], { repoId: REPO_ID })]), request: unblock(), expected: { ok: false, reason: 'moved', expected: 'needs human', observed: 'approved' } },
    { name: 'not-owned', snapshot: snapshotOf([repositoryState([item({ assignees: ['other'] })], { repoId: REPO_ID, viewer: 'op' })]), request: unblock(), expected: { ok: false, reason: 'not-owned', owners: ['other'] } },
    { name: 'cycle-cap for revise at the cap', snapshot: snapshotOf([repositoryState([item({ stage: 'terminal', stages: [stageLabel('approved', 'terminal')], reviewCycleCount: 5 })], { repoId: REPO_ID, reviewCycleCap: 5 })]), request: unblock({ decision: 'revise', expectedStage: 'approved', route: null, note: 'change it' }), expected: { ok: false, reason: 'refused', refusal: 'cycle-cap' } },
    { name: 'note-invalid for an empty revise note', snapshot: snapshotOf([repositoryState([item({ stage: 'terminal', stages: [stageLabel('approved', 'terminal')] })], { repoId: REPO_ID })]), request: unblock({ decision: 'revise', expectedStage: 'approved', route: null, note: '  ' }), expected: { ok: false, reason: 'refused', refusal: 'note-invalid', problem: 'empty' } },
  ])('refuses $name, before any read or write', async ({ snapshot, request, expected }) => {
    const rig = await operatorRig(ESCALATED)
    rig.github.failNextRead('must not be read')
    expect(await applyItemDecision(rig.ctx, { request, snapshot, entry: rig.entry, auditDir: rig.auditDir, scratchDir: rig.scratchDir, liveStage: false })).toEqual(expected)
    expect(rig.github.comments(300)).toEqual([])
  })

  it('refuses moved when the fresh re-read disagrees, and posts no comment', async () => {
    const { rig, result } = await decide({ rig: { ...ESCALATED, items: [{ number: 51, labels: ['port'], assignees: ['op'] }, { number: 300, kind: 'pull-request', labels: ['port', 'needs human'], assignees: ['someone-else'], headRefName: '51-fix' }] } })
    expect(result).toMatchObject({ ok: false, reason: 'moved' })
    expect(rig.github.comments(300)).toEqual([])
  })

  it('reports verify-failed when the re-read fails', async () => {
    const rig = await operatorRig(ESCALATED)
    rig.github.failNextRead('offline')
    const result = await applyItemDecision(rig.ctx, { request: unblock(), snapshot: snapshotOf([repositoryState([item()], { repoId: REPO_ID })]), entry: rig.entry, auditDir: rig.auditDir, scratchDir: rig.scratchDir, liveStage: false })
    expect(result).toMatchObject({ ok: false, reason: 'verify-failed' })
  })

  it('reports an unseeded repository as state-unsaved, with nothing posted', async () => {
    const { rig, result } = await decide({ rig: { ...ESCALATED, tickets: null } })
    expect(result).toMatchObject({ ok: true, comment: null, labels: { kind: 'state-unsaved' } })
    expect(rig.github.comments(300)).toEqual([])
  })
})

describe('applyItemDecision — comment then swap', () => {
  it('aborts comment-failed and moves nothing', async () => {
    const rig = await operatorRig(ESCALATED)
    rig.github.failComments('boom')
    const result = await applyItemDecision(rig.ctx, { request: unblock(), snapshot: snapshotOf([repositoryState([item({ comments: CYCLE_CAP })], { repoId: REPO_ID })]), entry: rig.entry, auditDir: rig.auditDir, scratchDir: rig.scratchDir, liveStage: false })
    expect(result).toMatchObject({ ok: false, reason: 'comment-failed', comment: { kind: 'write-failed', stderr: 'boom' } })
    expect(rig.ticket(51)?.rev).toBe(0)
  })

  it('skipComment skips the comment and goes straight to the swap', async () => {
    const { rig, result } = await decide({ request: unblock({ skipComment: true }) })
    expect(result).toMatchObject({ ok: true, comment: null, labels: { kind: 'applied' } })
    expect(rig.github.comments(300)).toEqual([])
    expect(rig.ticket(51)?.rev).toBe(1)
  })

  it.each([
    { name: 'refuses the review route on a sha-cap escalation and writes nothing', comments: comment('## Pipeline Escalation\nCycle 2 was the second review of `abc`.\n<!-- port:escalation sha-cap abc -->'), route: 'review' as const, ok: false },
    { name: 'still applies the review route on a cycle-cap escalation', comments: comment('## Pipeline Escalation\n5 review cycles reached the cap of 5 without merging.\n<!-- port:escalation cycle-cap abc -->'), route: 'review' as const, ok: true },
  ])('$name', async ({ comments, route, ok }) => {
    const { result } = await decide({ item: item({ comments }), request: unblock({ route }) })
    expect(result.ok).toBe(ok)
  })

  it.each([
    { name: 'posts a Cycle grant block when clearing a cycle-cap escalation back to revision', comments: CYCLE_CAP, grant: true },
    { name: 'posts no Cycle grant block when clearing a rebase escalation back to revision', comments: comment('## Pipeline Escalation\nthe branch needs a person'), grant: false },
  ])('$name', async ({ comments, grant }) => {
    const { rig, result } = await decide({ item: item({ comments }) })
    expect(result).toMatchObject({ ok: true })
    expect(rig.github.comments(300).join('\n').includes('### Cycle grant')).toBe(grant)
  })

  it('writes a comment audit entry, then label entries, all under the decision action', async () => {
    const { rig, result } = await decide({ item: item({ comments: CYCLE_CAP }) })
    expect(result.ok).toBe(true)
    const log = await readAuditLog(rig.auditDir)
    if (!log.ok) throw new Error('unreachable')
    const entries = log.entries.filter(isLabelAuditEntry)
    expect(entries[0]?.action).toBe('unblock')
    expect(entries[0]?.commentBytes).not.toBeNull()
    expect(entries.slice(1).every((entry) => entry.action === 'unblock' && entry.commentBytes === null && entry.result.kind === 'applied')).toBe(true)
    expect(entries.slice(1).length).toBeGreaterThan(0)
  })
})

const TWO_DECISION_ESCALATION = [
  '## Pipeline Escalation',
  '3 conflicts — 1 resolved automatically, 2 need a decision',
  '',
  '### D1 — `src/money.ts`',
  '**Ours:** half-up',
  '',
  '| Option | Keeps | Loses |',
  '| --- | --- | --- |',
  '| **A take ours** | half-up | half-even |',
  '| **B take theirs** | half-even | half-up |',
  '',
  '**Recommendation: B** — base ships half-even.',
  '',
  '### D2 — `src/format.ts`',
  '',
  '| Option | Keeps | Loses |',
  '| --- | --- | --- |',
  '| **A take ours** | two decimals | locale |',
  '| **B take theirs** | locale | two decimals |',
  '| **C keep both rounding modes** | a mode argument | one signature |',
].join('\n')

describe('applyItemDecision — rebase decisions', () => {
  const comments = comment(TWO_DECISION_ESCALATION)
  const picked = (overrides: Partial<ItemDecisionRequest> = {}) => unblock({ picks: [{ id: 'D1', letter: 'B' }, { id: 'D2', letter: 'C' }], ...overrides })

  it('posts the terminal path comment, then moves the ticket to revision', async () => {
    const { rig, result } = await decide({ item: item({ comments }), request: picked() })
    expect(result.ok).toBe(true)
    expect(rig.github.comments(300)).toEqual(['## Gate cleared\nCleared by the operator in port: back to revision.\n\n### Rebase decisions\n- D1 `src/money.ts` — **B take theirs**\n- D2 `src/format.ts` — **C keep both rounding modes**'])
    expect(rig.ticket(51)?.rev).toBe(1)
  })

  it.each([
    ['a missing pick', { picks: [{ id: 'D1', letter: 'B' }] }, 'missing D2'],
    ['no picks at all', { picks: null }, 'missing D1'],
    ['an unknown id', { picks: [{ id: 'D1', letter: 'B' }, { id: 'D2', letter: 'C' }, { id: 'D9', letter: 'A' }] }, 'unknown D9'],
    ['an off-menu letter', { picks: [{ id: 'D1', letter: 'C' }, { id: 'D2', letter: 'C' }] }, 'off-menu D1'],
  ])('refuses %s with picks-invalid and writes nothing', async (_name, overrides, problem) => {
    const { rig, result } = await decide({ item: item({ comments }), request: picked(overrides) })
    expect(result).toEqual({ ok: false, reason: 'refused', refusal: 'picks-invalid', problem })
    expect(rig.github.comments(300)).toEqual([])
  })

  it.each([
    { name: 'the review route on an escalation with decisions', comments, request: picked({ route: 'review' }), refusal: 'route-unavailable', problem: undefined },
    { name: 'picks on an escalation that carries no decisions', comments: comment('## Pipeline Escalation\nreason'), request: picked(), refusal: 'picks-invalid', problem: 'unexpected' },
    { name: 'a block that cannot be parsed', comments: comment('## Pipeline Escalation\n1 conflict\n### D1 — `a.ts`\nno table'), request: picked(), refusal: 'rebase-decisions', problem: undefined },
  ])('refuses $name', async ({ comments: given, request, refusal, problem }) => {
    const { result } = await decide({ item: item({ comments: given }), request })
    expect(result).toEqual({ ok: false, reason: 'refused', refusal, ...(problem === undefined ? {} : { problem }) })
  })
})

describe('applyItemDecision — blocked issue', () => {
  const BLOCKED: OperatorRigOptions = {
    viewer: 'op',
    items: [{ number: 51, labels: ['port', 'blocked'], assignees: ['op'] }],
    tickets: [ticketOf({ repo: REPO_ID, ticket: 51, stage: 'implement', status: { kind: 'blocked', on: [], reason: '' } })],
  }
  const blockedIssue = () => item({ kind: 'issue', number: 51, stage: 'gate', stages: [stageLabel('blocked', 'gate')], matchedKeys: ['blocked'], headRefOid: null })
  const request = (overrides: Partial<ItemDecisionRequest> = {}) => unblock({ number: 51, expectedStage: 'blocked', route: 'implementation', ...overrides })

  it('posts on the issue, then moves the ticket back to implementation', async () => {
    const { rig, result } = await decide({ rig: BLOCKED, item: blockedIssue(), request: request() })
    expect(result.ok).toBe(true)
    expect(rig.github.comments(51)).toEqual(['## Gate cleared\nCleared by the operator in port: back to implementation.'])
    expect(rig.ticket(51)).toMatchObject({ rev: 1, status: { kind: 'queued' } })
  })

  it('refuses agent-live and writes nothing while a stage session is live', async () => {
    const { rig, result } = await decide({ rig: BLOCKED, item: blockedIssue(), request: request(), liveStage: true })
    expect(result).toEqual({ ok: false, reason: 'refused', refusal: 'agent-live' })
    expect(rig.github.comments(51)).toEqual([])
  })

  it.each([
    { name: 'an issue is unblocked with a pull-request route', rig: BLOCKED, item: blockedIssue(), request: request({ route: 'review' }), message: /does not fit issue #51/ },
    { name: 'a pull request is unblocked with the implementation route', rig: ESCALATED, item: item(), request: unblock({ route: 'implementation' }), message: /does not fit pull-request #300/ },
  ])('throws when $name', async ({ rig, item: given, request: asked, message }) => {
    await expect(decide({ rig, item: given, request: asked })).rejects.toThrow(message)
  })
})
