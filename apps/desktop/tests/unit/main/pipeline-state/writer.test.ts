import { describe, expect, it, vi } from 'vitest'
import { createStateWriter } from '@/main/pipeline-state/writer'
import type { PipelineStateStore, StoreTransitionResult } from '@/types/pipeline-state'
import type { ApplyLabelsParams, AuditEntry, LabelAuditEntry, LabelWriteRequest, WriteOutcome } from '@/types/writes'
import type { OwnershipRead } from '@/types/dispatch'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'

const REPO = 'repo-a' as RepoId
const VOCABULARY = resolveVocabulary({})
const NOW = () => new Date('2026-01-01T00:00:00.000Z')
const ITEM = { kind: 'issue' as const, number: 7, keys: ['planApproved' as const], marked: true, autoPlan: false, claimedAt: null, reviewCycles: 0, history: [], updatedAt: 't' }

function request(overrides: Partial<LabelWriteRequest> = {}): LabelWriteRequest {
  return {
    repoId: REPO,
    repo: 'o/a',
    kind: 'issue',
    number: 7,
    vocabulary: VOCABULARY,
    add: ['inProgress'],
    remove: ['planApproved'],
    addAssignees: [],
    removeAssignees: [],
    expect: { present: ['planApproved'], absent: ['inProgress'], assignees: { kind: 'exactly', logins: ['op'] } },
    action: 'stage-claim',
    ...overrides,
  }
}

interface RigOptions {
  readonly view?: 'labels' | 'store'
  readonly transition?: StoreTransitionResult
  readonly mirror?: WriteOutcome
  readonly ownership?: OwnershipRead['kind']
  readonly githubLabels?: readonly string[]
  readonly assignees?: readonly string[]
}

function rig(options: RigOptions = {}) {
  const audits: AuditEntry[] = []
  const mirrors: ApplyLabelsParams[] = []
  const transition = vi.fn((): Promise<StoreTransitionResult> => Promise.resolve(options.transition ?? { ok: true, changed: true }))
  const store = {
    view: () => (options.view === 'labels' ? { kind: 'labels' as const } : { kind: 'store' as const, items: [ITEM] }),
    transition,
  } as unknown as PipelineStateStore
  const applyLabels = vi.fn((params: ApplyLabelsParams): Promise<WriteOutcome> => {
    mirrors.push(params)
    return Promise.resolve(options.mirror ?? { kind: 'applied', argv: ['issue', 'edit'] })
  })
  const ownership: OwnershipRead = options.ownership === 'terminal' ? { kind: 'terminal', since: 's', path: 'p', readAt: 'r' } : options.ownership === 'unreadable' ? { kind: 'unreadable', message: 'bad', path: 'p', readAt: 'r' } : { kind: 'app', since: 's', path: 'p', readAt: 'r' }
  const writeState = createStateWriter({
    store,
    applyLabels,
    readOwnership: () => Promise.resolve(ownership),
    fetchItemsByNumber: () =>
      Promise.resolve({ ok: true, resolved: [{ number: 7, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: options.githubLabels ?? [], assignees: options.assignees ?? ['op'], headRefName: null, author: null }], unavailable: [], fetchedAt: 'r' }),
    appendAudit: (_dir, entry) => Promise.resolve(void audits.push(entry)),
    now: NOW,
  })
  return { writeState, transition, applyLabels, mirrors, audits }
}

describe('createStateWriter', () => {
  it('moves the state first, then mirrors the label diff with the label precondition emptied', async () => {
    const { writeState, transition, mirrors } = rig({ githubLabels: [] })
    const outcome = await writeState({ request: request(), repoRoot: '/repo', auditDir: '/audit' })
    expect(outcome).toEqual({ kind: 'applied', argv: ['issue', 'edit'] })
    expect(transition).toHaveBeenCalledWith(REPO, { kind: 'issue', number: 7 }, expect.objectContaining({ add: ['inProgress'], remove: ['planApproved'], expect: { present: ['planApproved'], absent: ['inProgress'] }, action: 'stage-claim' }))
    expect(mirrors).toHaveLength(1)
    expect(mirrors[0]?.request.expect).toEqual({ present: [], absent: [], assignees: { kind: 'any' } })
    expect(mirrors[0]?.request.add).toEqual(['inProgress'])
  })

  it('does not care what labels GitHub carries, only what the store holds', async () => {
    const { writeState, mirrors } = rig({ githubLabels: ['unrelated'] })
    expect((await writeState({ request: request(), repoRoot: '/repo', auditDir: '/audit' })).kind).toBe('applied')
    expect(mirrors).toHaveLength(1)
  })

  it('passes a no-op mirror through', async () => {
    const { writeState } = rig({ mirror: { kind: 'no-op' } })
    expect(await writeState({ request: request(), repoRoot: '/repo', auditDir: '/audit' })).toEqual({ kind: 'no-op' })
  })

  it('reports mirror-failed when the label write fails, without undoing the state', async () => {
    const failed: WriteOutcome = { kind: 'write-failed', classification: 'network', stderr: 'offline', reread: null }
    const { writeState, transition } = rig({ mirror: failed })
    expect(await writeState({ request: request(), repoRoot: '/repo', auditDir: '/audit' })).toEqual({ kind: 'mirror-failed', mirror: failed })
    expect(transition).toHaveBeenCalledTimes(1)
  })

  it('refuses with the stored names, expected against observed, and writes no label, when the store disagrees', async () => {
    const { writeState, applyLabels, audits } = rig({ transition: { ok: false, reason: 'precondition-failed' } })
    const outcome = await writeState({ request: request({ expect: { present: ['ready'], absent: [], assignees: { kind: 'any' } } }), repoRoot: '/repo', auditDir: '/audit' })
    expect(outcome).toMatchObject({ kind: 'precondition-failed', conflict: { expected: ['ready'], observed: ['claude', 'plan approved'] } })
    expect(applyLabels).not.toHaveBeenCalled()
    expect((audits[0] as LabelAuditEntry).result.kind).toBe('precondition-failed')
  })

  it('reports state-unsaved, nothing changed, when the store cannot persist', async () => {
    const { writeState, applyLabels } = rig({ transition: { ok: false, reason: 'persist-failed', message: 'disk full' } })
    expect(await writeState({ request: request(), repoRoot: '/repo', auditDir: '/audit' })).toEqual({ kind: 'state-unsaved', message: 'disk full' })
    expect(applyLabels).not.toHaveBeenCalled()
  })

  it('refuses on the assignee half, from GitHub, before the store is touched', async () => {
    const { writeState, transition } = rig({ assignees: ['someone-else'] })
    expect(await writeState({ request: request(), repoRoot: '/repo', auditDir: '/audit' })).toMatchObject({ kind: 'precondition-failed', conflict: { expected: ['op'], observed: ['someone-else'] } })
    expect(transition).not.toHaveBeenCalled()
  })

  it.each(['labels', 'terminal', 'unreadable'] as const)('hands %s straight to applyLabels, with the request untouched and no store change', async (mode) => {
    const { writeState, transition, mirrors } = rig(mode === 'labels' ? { view: 'labels' } : { ownership: mode })
    await writeState({ request: request(), repoRoot: '/repo', auditDir: '/audit' })
    expect(transition).not.toHaveBeenCalled()
    expect(mirrors[0]?.request).toEqual(request())
  })

  it('hands an unresolvable key to applyLabels, which reports it', async () => {
    const { writeState, transition, mirrors } = rig()
    const withoutInProgress = { ...VOCABULARY, labels: VOCABULARY.labels.filter((label) => label.key !== 'inProgress') }
    await writeState({ request: request({ vocabulary: withoutInProgress }), repoRoot: '/repo', auditDir: '/audit' })
    expect(transition).not.toHaveBeenCalled()
    expect(mirrors).toHaveLength(1)
  })
})
