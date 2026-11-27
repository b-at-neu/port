import { describe, expect, it } from 'vitest'
import { itemDecide } from '@/main/features/item/actions/decide'
import type { RepoId } from '@/utils/repos'
import { ticketViewOf } from '@/utils/pipeline/stages'
import { boardSnapshot, reconciledItem, repositoryState } from '../../../support/board-snapshot'
import { callAction, createTestContext } from '../../../support/context'
import { operatorRig, recordingWatcher, REPO_ID, type OperatorRigOptions } from '../../../support/operator-rig'
import { stageSession } from '../../../support/session-snapshot'
import { ticketOf } from '../../../support/tickets'

const BASE = { repoId: REPO_ID, number: 1, expected: null, route: null, note: null, skipComment: false, picks: null }

describe('item.decide input', () => {
  it.each([
    { name: 'unblock with a route', input: { ...BASE, decision: 'unblock', route: 'revision' }, ok: true },
    { name: 'unblock with well-formed picks', input: { ...BASE, decision: 'unblock', route: 'revision', picks: [{ id: 'D1', letter: 'B' }] }, ok: true },
    { name: 'unblock with no route', input: { ...BASE, decision: 'unblock' }, ok: false },
    { name: 'unblock carrying a note', input: { ...BASE, decision: 'unblock', route: 'revision', note: 'oops' }, ok: false },
    { name: 'unblock with a malformed pick', input: { ...BASE, decision: 'unblock', route: 'revision', picks: [{ id: 'one', letter: 'A' }] }, ok: false },
    { name: 'grant with nothing else', input: { ...BASE, decision: 'grant' }, ok: true },
    { name: 'grant carrying a route', input: { ...BASE, decision: 'grant', route: 'revision' }, ok: false },
    { name: 'grant carrying a note', input: { ...BASE, decision: 'grant', note: 'hi' }, ok: false },
    { name: 'grant carrying picks', input: { ...BASE, decision: 'grant', picks: [{ id: 'D1', letter: 'A' }] }, ok: false },
    { name: 'grant skipping the comment', input: { ...BASE, decision: 'grant', skipComment: true }, ok: false },
    { name: 'revise with a note', input: { ...BASE, decision: 'revise', note: 'change this' }, ok: true },
    { name: 'revise without a note', input: { ...BASE, decision: 'revise' }, ok: false },
    { name: 'revise carrying a route', input: { ...BASE, decision: 'revise', note: 'x', route: 'revision' }, ok: false },
    { name: 'revise carrying picks', input: { ...BASE, decision: 'revise', note: 'x', picks: [{ id: 'D1', letter: 'A' }] }, ok: false },
  ])('$name', ({ input, ok }) => {
    expect(itemDecide.input.safeParse(input).success).toBe(ok)
  })
})

describe('item.action', () => {
  const request = { repoId: REPO_ID, kind: 'issue' as const, number: 148, action: 'pause' as const, expected: null }

  it('rejects an unregistered repository', async () => {
    const ctx = createTestContext({ live: { watcher: recordingWatcher().watcher } })
    await expect(callAction(ctx, 'item.action', request)).rejects.toThrow(`'item:action' found no repository registered with id '${REPO_ID}'`)
  })

  it('rejects a repository that is not ready', async () => {
    const entry = { id: REPO_ID, path: '/repo', displayName: 'widgets', problem: { kind: 'directory-missing' as const }, diagnostics: [] }
    const ctx = createTestContext({ repositories: [entry], live: { watcher: recordingWatcher().watcher } })
    await expect(callAction(ctx, 'item.action', request)).rejects.toThrow("'item:action' requires a 'ready' repository, got 'directory-missing'")
  })

  it('records no refresh for a refusal', async () => {
    const { watcher, refreshes } = recordingWatcher()
    const rig = await operatorRig({ live: { watcher } })
    expect(await callAction(rig.ctx, 'item.action', request)).toEqual({ ok: false, reason: 'repo-unavailable' })
    expect(refreshes).toEqual([])
  })
})

describe('item.decide', () => {
  const ESCALATED: OperatorRigOptions = {
    viewer: 'op',
    items: [
      { number: 51, labels: ['port'], assignees: ['op'] },
      { number: 300, kind: 'pull-request', labels: ['port', 'needs human'], assignees: ['op'], headRefName: '51-fix', headRefOid: 'a'.repeat(40) },
    ],
    tickets: [ticketOf({ repo: REPO_ID, ticket: 51, pr: { number: 300, approvedAt: null }, stage: 'review', status: { kind: 'waiting-on-you', gate: 'escalation', detail: '' } })],
  }
  const escalated = ticketOf({ repo: REPO_ID, ticket: 51, pr: { number: 300, approvedAt: null }, stage: 'review', status: { kind: 'waiting-on-you', gate: 'escalation', detail: '' } })
  const pullRequest = reconciledItem({ repoId: REPO_ID, kind: 'pull-request', number: 300, ticket: escalated, headRefOid: 'a'.repeat(40), mergeable: 'MERGEABLE', reviewCycleCount: 0 })
  const snapshot = boardSnapshot([repositoryState([pullRequest], { repoId: REPO_ID })])
  const unblock = { repoId: REPO_ID, number: 300, decision: 'unblock' as const, expected: ticketViewOf(escalated), route: 'revision' as const, note: null, skipComment: true, picks: null }

  it('forces one github refresh after an applied unblock', async () => {
    const { live, refreshes } = recordingWatcher({ snapshot })
    const rig = await operatorRig({ ...ESCALATED, live })
    expect(await callAction(rig.ctx, 'item.decide', unblock)).toMatchObject({ ok: true, labels: { kind: 'applied' } })
    expect(refreshes).toEqual([{ repoId: REPO_ID, source: 'github' }])
  })

  it('still returns the applied result when the refresh throws', async () => {
    const { live } = recordingWatcher({ snapshot, failRefresh: true })
    const rig = await operatorRig({ ...ESCALATED, live })
    expect(await callAction(rig.ctx, 'item.decide', unblock)).toMatchObject({ ok: true, labels: { kind: 'applied' } })
  })

  it('refuses as moved and records no refresh when the record holds no ticket', async () => {
    const { live, refreshes } = recordingWatcher({ snapshot })
    const rig = await operatorRig({ ...ESCALATED, tickets: [], live })
    expect(await callAction(rig.ctx, 'item.decide', unblock)).toMatchObject({ ok: false, reason: 'moved' })
    expect(refreshes).toEqual([])
  })

  it.each([
    { name: 'a live session for this number', sessions: [stageSession({ repoId: REPO_ID, stage: { agent: 'impl', number: 300, kind: 'issue' } })], live: true },
    { name: 'an ended session for this number', sessions: [stageSession({ repoId: REPO_ID, phase: 'ended', stage: { agent: 'impl', number: 300, kind: 'issue' } })], live: false },
    { name: 'a live session for another number', sessions: [stageSession({ repoId: REPO_ID, stage: { agent: 'impl', number: 52, kind: 'issue' } })], live: false },
    { name: 'a live session in another repository', sessions: [stageSession({ repoId: 'repo-2' as RepoId, stage: { agent: 'impl', number: 300, kind: 'issue' } })], live: false },
  ])('treats $name as liveStage=$live', async ({ sessions, live: refused }) => {
    const blockedTicket = ticketOf({ repo: REPO_ID, ticket: 300, stage: 'implement', status: { kind: 'blocked', on: [], reason: 'stuck' } })
    const blocked = reconciledItem({ repoId: REPO_ID, kind: 'issue', number: 300, assignees: ['op'], ticket: blockedTicket })
    const { live } = recordingWatcher({ snapshot: boardSnapshot([repositoryState([blocked], { repoId: REPO_ID })]), sessions })
    const rig = await operatorRig({ viewer: 'op', items: [{ number: 300, labels: ['port'], assignees: ['op'] }], tickets: [blockedTicket], live })
    const result = await callAction(rig.ctx, 'item.decide', { ...unblock, expected: ticketViewOf(blockedTicket), route: 'implementation' })
    expect(result.ok === false && result.reason === 'refused' && result.refusal === 'agent-live').toBe(refused)
  })
})
