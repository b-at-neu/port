import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mirrorItem, writeEvent, writeState } from '@/main/pipeline/state/writer'
import { readAuditLog } from '@/main/github/writes/audit'
import type { IncidentDraft, IncidentIntent } from '@/types/incidents'
import type { MirrorFailure } from '@/types/pipeline-state'
import { isLabelAuditEntry, type EventWriteRequest, type LabelWriteRequest } from '@/types/writes'
import { resolveDisplayVocabulary, type MirrorVocabulary } from '@/utils/labels/display'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { Ticket } from '@/utils/pipeline/ticket'
import type { RepoId } from '@/utils/repos'
import { createTestContext } from '../../../../support/context'
import { createFakeFs } from '../../../../support/fake-platform'
import { createFakeGitHub, type FakeItem } from '../../../../support/fake-github'
import { readyEntry } from '../../../../support/repo-config'
import { AT } from '../../../../support/state-store'
import { ticketOf } from '../../../../support/tickets'

const REPO = 'repo-a' as RepoId
const VOCABULARY = resolveVocabulary({})
const DISPLAY: MirrorVocabulary = { kind: 'display', labels: resolveDisplayVocabulary({}) }
const queued = { kind: 'queued' as const, reason: 'new' as const, since: AT }
const running = { kind: 'running' as const, runId: null }
const PR_ITEM: FakeItem = { number: 9, kind: 'pull-request', headRefName: '7-the-fix', assignees: ['op'] }

const issueTicket = (overrides: Partial<Ticket> = {}): Ticket => ticketOf({ repo: REPO, ticket: 7, stage: 'implement', status: queued, ...overrides })
const withPr = (overrides: Partial<Ticket> = {}): Ticket => issueTicket({ pr: { number: 9, approvedAt: null }, stage: 'review', ...overrides })
const issueItem = (labels: readonly string[]): FakeItem => ({ number: 7, labels, assignees: ['op'] })

function request(overrides: Partial<LabelWriteRequest> = {}): LabelWriteRequest {
  return {
    repoId: REPO,
    repo: 'o/a',
    kind: 'issue',
    number: 7,
    vocabulary: VOCABULARY,
    mirror: DISPLAY,
    add: ['inProgress'],
    remove: ['planApproved'],
    addAssignees: [],
    removeAssignees: [],
    expect: { present: ['planApproved'], absent: [], assignees: { kind: 'exactly', logins: ['op'] } },
    action: 'stage-claim',
    ...overrides,
  }
}

const eventRequest = (overrides: Partial<EventWriteRequest> = {}): EventWriteRequest => ({ repoId: REPO, repo: 'o/a', kind: 'issue', number: 7, vocabulary: VOCABULARY, mirror: DISPLAY, event: { kind: 'claim', stage: 'implement' }, expectedRev: 0, assignees: { kind: 'any' }, addAssignees: [], removeAssignees: [], action: 'stage-claim', ...overrides })

const prRequest = (overrides: Partial<LabelWriteRequest> = {}): LabelWriteRequest =>
  request({ kind: 'pull-request', number: 9, add: ['needsRevision'], remove: ['readyForReview'], expect: { present: ['readyForReview'], absent: [], assignees: { kind: 'any' } }, ...overrides })

interface RigOptions {
  /** `null` leaves the repository unseeded. */
  readonly tickets?: readonly Ticket[] | null
  readonly items?: readonly FakeItem[]
  readonly unreadableOwnership?: boolean
  readonly persistFails?: boolean
  readonly incidentFails?: boolean
}

async function rig(options: RigOptions = {}) {
  const incidents: IncidentDraft[] = []
  const github = createFakeGitHub({ items: options.items ?? [issueItem([])] })
  const fs = createFakeFs()
  let persistFails = false
  const incidentLog = {
    record: (draft: IncidentDraft) => (options.incidentFails === true ? Promise.reject(new Error('disk full')) : Promise.resolve(void incidents.push(draft))),
    read: () => Promise.reject(new Error('unused')),
  }
  const tickets = options.tickets === undefined ? [issueTicket()] : options.tickets
  const ctx = createTestContext({
    platform: { ...github.platform, fs: { ...fs, writeJsonAtomic: (path, value) => (persistFails ? Promise.resolve({ ok: false, kind: 'io', message: 'disk full' }) : fs.writeJsonAtomic(path, value)) } },
    ...(tickets === null ? {} : { tickets: { repoId: REPO, tickets } }),
    stores: { incidentLog },
  })
  await ctx.ready
  persistFails = options.persistFails === true
  if (options.unreadableOwnership === true) await fs.writeText('/repo/.agents/cockpit.json', JSON.stringify({ repo: 'o/a', owner: 'terminal', since: AT }))
  const auditDir = await mkdtemp(join(tmpdir(), 'port-writer-'))
  const ticket = (number = 7, kind: 'issue' | 'pull-request' = 'issue') => ctx.stores.pipelineState.ticket(REPO, { kind, number })
  const audits = async () => {
    const read = await readAuditLog(auditDir)
    return read.ok ? read.entries : []
  }
  return {
    ctx,
    github,
    incidents,
    ticket,
    audits,
    state: (req: LabelWriteRequest = request()) => writeState(ctx, { request: req, repoRoot: '/repo', auditDir }),
    event: (req: EventWriteRequest = eventRequest()) => writeEvent(ctx, { request: req, repoRoot: '/repo', auditDir }),
    mirror: (ref: { kind: 'issue' | 'pull-request'; number: number }, action: string) => mirrorItem(ctx, { entry: readyEntry({ id: REPO }), ref, action, auditDir }),
  }
}

const sorted = (labels: readonly string[]): string[] => [...labels].sort()

describe('writeState — the display mirror', () => {
  it.each([
    { name: 'swaps the old stage label for the new one', before: ['port', 'planning'], after: ['implementing', 'port'] },
    { name: 'removes a state label added by hand and restores a removed port label', before: ['approved', 'revising'], after: ['implementing', 'port'] },
    { name: 'removes a legacy label the item still carries', before: ['claude', 'plan approved', 'ready'], after: ['implementing', 'port'] },
  ])('commits the ticket, then $name', async ({ before, after }) => {
    const r = await rig({ items: [issueItem(before)] })
    expect(await r.state()).toMatchObject({ kind: 'applied' })
    expect(r.ticket()).toMatchObject({ rev: 1, stage: 'implement', status: { kind: 'running' } })
    expect(sorted(r.github.labels(7))).toEqual(after)
  })

  it('never touches a label outside both vocabularies', async () => {
    const r = await rig({ items: [issueItem(['port', 'implementing', 'bug'])] })
    expect(await r.state()).toEqual({ kind: 'no-op' })
    expect(sorted(r.github.labels(7))).toEqual(['bug', 'implementing', 'port'])
  })

  it('shows needs you with the state at a gate', async () => {
    const r = await rig({ tickets: [issueTicket({ stage: 'plan', status: running })], items: [issueItem(['port', 'planning'])] })
    await r.state(request({ add: ['planReview'], remove: ['planning'], expect: { present: ['planning'], absent: [], assignees: { kind: 'any' } } }))
    expect(r.github.labels(7)).toContain('needs you')
  })

  it("carries the request's assignee changes on the target write", async () => {
    const r = await rig({ items: [{ number: 7, assignees: ['op', 'other'] }] })
    await r.state(request({ addAssignees: ['third'], removeAssignees: ['other'], expect: { present: ['planApproved'], absent: [], assignees: { kind: 'any' } } }))
    expect(sorted(r.github.assignees(7))).toEqual(['op', 'third'])
  })
})

describe('writeEvent', () => {
  it('commits a typed event on the rev the caller read, then mirrors the display labels', async () => {
    const r = await rig({ items: [issueItem(['port'])] })
    expect(await r.event()).toMatchObject({ kind: 'applied' })
    expect(r.ticket()).toMatchObject({ rev: 1, status: { kind: 'running' } })
    expect(sorted(r.github.labels(7))).toEqual(['implementing', 'port'])
  })

  it('refuses a rev another write already moved, with no label write', async () => {
    const r = await rig({ tickets: [issueTicket({ rev: 3 })], items: [issueItem(['port'])] })
    expect(await r.event()).toMatchObject({ kind: 'precondition-failed' })
    expect(r.ticket()?.rev).toBe(3)
    expect(r.github.labels(7)).toEqual(['port'])
  })

  it('opens the pull request as one commit and mirrors both halves', async () => {
    const r = await rig({ tickets: [issueTicket({ status: running })], items: [issueItem(['port', 'implementing']), PR_ITEM] })
    const event = { kind: 'handback', stage: 'implement', token: 'pr-opened', arg: '9', pr: 9, via: 'session' } as const
    await r.event(eventRequest({ event, action: 'stage-handback-pr-opened' }))
    expect(r.ticket()).toMatchObject({ rev: 1, stage: 'review', pr: { number: 9 } })
    expect(sorted(r.github.labels(7))).toEqual(['port', 'reviewing'])
    expect(sorted(r.github.labels(9))).toEqual(['port', 'reviewing'])
  })
})

describe('writeState — outcomes', () => {
  it('reports mirror-failed and records the failure on the ticket when the label write fails, without undoing the state', async () => {
    const r = await rig()
    r.github.failWrites(7, 'offline')
    expect(await r.state()).toMatchObject({ kind: 'mirror-failed', mirror: { kind: 'write-failed', stderr: 'offline' } })
    expect(r.ticket()).toMatchObject({ rev: 1, mirror: { failure: { outcome: { kind: 'write-failed' } } } })
  })

  it('clears a recorded failure once the write lands', async () => {
    const failure: MirrorFailure = { at: AT, outcome: { kind: 'item-unavailable' } }
    const r = await rig({ tickets: [issueTicket({ mirror: { written: [], failure } })] })
    await r.state()
    expect(r.ticket()?.mirror.failure).toBeNull()
  })

  it('refuses with the stored names, expected against observed, and writes no label, when the store disagrees', async () => {
    const r = await rig({ items: [issueItem(['port'])] })
    const outcome = await r.state(request({ expect: { present: ['ready'], absent: [], assignees: { kind: 'any' } } }))
    expect(outcome).toMatchObject({ kind: 'precondition-failed', conflict: { expected: ['ready'], observed: ['claude', 'plan approved'] } })
    expect(r.github.labels(7)).toEqual(['port'])
    expect((await r.audits()).filter(isLabelAuditEntry).map((entry) => entry.result.kind)).toEqual(['precondition-failed'])
  })

  it('reports state-unsaved, nothing changed, when the store cannot persist', async () => {
    const r = await rig({ persistFails: true, items: [issueItem(['port'])] })
    expect(await r.state()).toEqual({ kind: 'state-unsaved', message: 'disk full' })
    expect(r.github.labels(7)).toEqual(['port'])
    expect(r.ticket()?.rev).toBe(0)
  })

  it('refuses on the assignee half, from GitHub, before the store is touched', async () => {
    const r = await rig()
    const outcome = await r.state(request({ expect: { present: ['planApproved'], absent: [], assignees: { kind: 'exactly', logins: ['someone-else'] } } }))
    expect(outcome).toMatchObject({ kind: 'precondition-failed', conflict: { expected: ['someone-else'], observed: ['op'] } })
    expect(r.ticket()?.rev).toBe(0)
  })

  it('refuses a repository whose state is not loaded yet, with no store change', async () => {
    const r = await rig({ tickets: null, items: [issueItem(['port'])] })
    expect(await r.state()).toEqual({ kind: 'state-unsaved', message: "port hasn't loaded this repository's pipeline state yet" })
    expect(r.github.labels(7)).toEqual(['port'])
  })

  it('refuses unreadable ownership, audited, with no store change and no label write', async () => {
    const r = await rig({ unreadableOwnership: true, items: [issueItem(['port'])] })
    expect((await r.state()).kind).toBe('ownership-unreadable')
    expect(r.ticket()?.rev).toBe(0)
    expect(r.github.labels(7)).toEqual(['port'])
    expect(await r.audits()).toHaveLength(1)
  })

  it('reports an unresolvable key, audited, before touching the store', async () => {
    const r = await rig()
    const withoutInProgress = { ...VOCABULARY, labels: VOCABULARY.labels.filter((label) => label.key !== 'inProgress') }
    expect(await r.state(request({ vocabulary: withoutInProgress }))).toEqual({ kind: 'unresolvable-label', keys: ['inProgress'] })
    expect(r.ticket()?.rev).toBe(0)
    expect(await r.audits()).toHaveLength(1)
  })
})

describe('writeState — the counterpart', () => {
  it("re-mirrors the issue of a pull request in the same call, showing the pull request's state", async () => {
    const r = await rig({ tickets: [withPr({ status: queued })], items: [issueItem(['port', 'implementing']), { ...PR_ITEM, labels: ['port', 'reviewing'] }] })
    await r.state(prRequest())
    expect(sorted(r.github.labels(9))).toEqual(['port', 'revising'])
    expect(sorted(r.github.labels(7))).toEqual(['port', 'revising'])
  })

  it('records a counterpart failure but returns the target outcome', async () => {
    const r = await rig({ tickets: [withPr({ status: queued })], items: [issueItem(['port', 'implementing']), { ...PR_ITEM, labels: ['port', 'reviewing'] }] })
    r.github.failWrites(7, 'offline')
    expect((await r.state(prRequest())).kind).toBe('applied')
    expect(r.ticket(9, 'pull-request')?.mirror.failure?.outcome).toMatchObject({ kind: 'write-failed', stderr: 'offline' })
  })

  it("learns a pull request's ticket from its branch and mirrors the issue too", async () => {
    const r = await rig({ tickets: [issueTicket({ status: running })], items: [issueItem(['port', 'implementing']), PR_ITEM] })
    await r.state(request({ kind: 'pull-request', number: 9, add: ['readyForReview'], remove: [], expect: { present: [], absent: [], assignees: { kind: 'any' } } }))
    expect(r.ticket(9, 'pull-request')).toMatchObject({ ticket: 7, pr: { number: 9 }, stage: 'review' })
    expect(r.github.labels(7)).toContain('reviewing')
    expect(r.github.labels(9)).toContain('reviewing')
  })

  it("writes an issue write's pull request when its labels have drifted", async () => {
    const r = await rig({ tickets: [withPr({ status: running })], items: [issueItem(['port', 'implementing']), { ...PR_ITEM, labels: ['approved'] }] })
    await r.state(request({ add: [], remove: [], expect: { present: ['prOpened'], absent: [], assignees: { kind: 'any' } } }))
    expect(sorted(r.github.labels(7))).toEqual(['port', 'reviewing'])
    expect(sorted(r.github.labels(9))).toEqual(['port', 'reviewing'])
  })
})

describe('mirrorItem', () => {
  it('writes the terminal state of a merged ticket on both halves without a store transition', async () => {
    const r = await rig({ tickets: [withPr({ stage: 'merge', status: { kind: 'done', at: AT } })], items: [issueItem(['port', 'implementing']), PR_ITEM] })
    expect((await r.mirror({ kind: 'pull-request', number: 9 }, 'mirror-merged')).kind).toBe('applied')
    expect(r.ticket()?.rev).toBe(0)
    expect(r.github.labels(7)).toContain('approved')
    expect(sorted(r.github.labels(9))).toEqual(['approved', 'port'])
  })

  it('records a failed retry and reports the outcome', async () => {
    const r = await rig()
    r.github.failWrites(7, "label 'reviewing' not found")
    const outcome = await r.mirror({ kind: 'issue', number: 7 }, 'mirror-retry')
    expect(outcome).toMatchObject({ kind: 'write-failed', stderr: "label 'reviewing' not found" })
    expect(r.ticket()?.mirror.failure?.outcome).toEqual(outcome)
  })

  it('reports an item the store does not hold as unavailable without writing', async () => {
    const r = await rig({ items: [issueItem(['port'])] })
    expect(await r.mirror({ kind: 'issue', number: 99 }, 'mirror-retry')).toEqual({ kind: 'item-unavailable' })
    expect(r.github.labels(7)).toEqual(['port'])
  })
})

const INTENT: IncidentIntent = {
  bucket: 'duplicate-head',
  stage: 'needsHuman',
  condition: 'zero-diff',
  decision: { action: 'observe-zero-diff', detail: 'zero-diff', intended: null },
  inputs: { observedHead: 'old-head', snapshotAt: 'tick-1' },
}

const withHead = (headRefOid: string): RigOptions => ({ tickets: [withPr({ status: queued })], items: [issueItem(['port']), { ...PR_ITEM, headRefOid }] })

describe('writeState — incidents', () => {
  it('records the intent as raised when the head read at write time is the one it observed', async () => {
    const r = await rig(withHead('old-head'))
    await r.state(prRequest({ incident: INTENT }))
    expect(r.incidents).toHaveLength(1)
    expect(r.incidents[0]).toMatchObject({ bucket: 'duplicate-head', stage: 'needsHuman', condition: 'zero-diff', repo: 'o/a', number: 9, outcome: { kind: 'applied' }, related: { tick: 'tick-1' } })
    expect(r.incidents[0]?.inputs).toMatchObject({ observedHead: 'old-head', writeHead: 'old-head' })
  })

  it('moves the incident to stale-snapshot, carrying both heads, when the head moved since the decision', async () => {
    const r = await rig(withHead('new-head'))
    await r.state(prRequest({ incident: INTENT }))
    expect(r.incidents[0]).toMatchObject({ bucket: 'stale-snapshot', stage: 'needsHuman', condition: 'head-moved', decision: { action: 'observe-zero-diff', intended: 'duplicate-head' } })
    expect(r.incidents[0]?.inputs).toMatchObject({ observedHead: 'old-head', writeHead: 'new-head' })
  })

  it('records a refused write that has no intent of its own, and names a refused typed event by its stage', async () => {
    const r = await rig({ unreadableOwnership: true })
    expect(await r.state()).toMatchObject({ kind: 'ownership-unreadable' })
    expect(r.incidents[0]).toMatchObject({ bucket: 'refused-write', stage: 'inProgress', condition: 'ownership-unreadable', outcome: { kind: 'ownership-unreadable' } })
    await r.event()
    expect(r.incidents[1]).toMatchObject({ bucket: 'refused-write', stage: 'implement' })
  })

  it('records nothing for a write that landed with no intent', async () => {
    const r = await rig()
    await r.state()
    expect(r.incidents).toHaveLength(0)
  })

  it('stamps the incident and the audit entry with the same write id', async () => {
    const r = await rig(withHead('old-head'))
    await r.state(prRequest({ incident: INTENT }))
    const ids = (await r.audits()).flatMap((entry) => ('writeId' in entry && entry.writeId !== undefined ? [entry.writeId] : []))
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids)).toEqual(new Set(r.incidents[0]?.related.audit))
  })

  it('leaves every outcome unchanged when recording the incident fails', async () => {
    const ok = await rig({ incidentFails: true })
    expect(await ok.state(request({ incident: INTENT }))).toMatchObject({ kind: 'applied' })
    const refused = await rig({ incidentFails: true, unreadableOwnership: true })
    expect(await refused.state()).toMatchObject({ kind: 'ownership-unreadable' })
  })
})
