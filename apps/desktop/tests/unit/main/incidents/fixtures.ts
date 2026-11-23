// Shared rigs for the incident tests: a reconciled item and a real state writer over an in-memory store.
import { vi } from 'vitest'
import { itemKey, recordMirror, transition, viewOf, withItem } from '@/main/pipeline-state/model'
import { createStateWriter } from '@/main/pipeline-state/writer'
import type { FileResult } from '@/types/platform'
import type { ReadyEntry } from '@/types/actions'
import type { IncidentDraft, IncidentFiles } from '@/types/incidents'
import type { MirrorFailure, PipelineStateStore, RepoRecord, StoredItem } from '@/types/pipeline-state'
import type { ReconciledItem } from '@/types/state'
import type { WriteOutcome } from '@/types/writes'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'

export const REPO_ID = 'repo-a' as RepoId
export const REPO = 'o/r'
export const VOCABULARY = resolveVocabulary({})
export const ENTRY = { id: REPO_ID, path: '/repo', config: { repo: REPO, owner: 'o', name: 'r', vocabulary: VOCABULARY, branches: { integration: 'dev' } } } as unknown as ReadyEntry

export function item(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return {
    repoId: REPO_ID,
    repo: REPO,
    kind: 'pull-request',
    number: 789,
    title: 'a pull request',
    url: 'https://github.com/o/r/pull/789',
    assignees: ['op'],
    stage: 'trigger',
    stages: [{ key: 'readyForReview', name: 'ready for review', role: 'trigger' }],
    stageAmbiguous: false,
    marked: true,
    autoPlan: false,
    status: 'waiting',
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
    stageHistory: [{ key: 'readyForReview', actor: null, at: '2026-11-16T10:00:00.000Z' }],
    matchedKeys: ['readyForReview'],
    sources: ['github'],
    claimedFiles: null,
    headRefOid: 'f19c6d5',
    mergeable: null,
    reviews: null,
    comments: null,
    reviewCycleCount: null,
    checkRollup: null,
    planPresent: null,
    blockers: null,
    blockerComments: null,
    closingPullRequests: null,
    ...overrides,
  }
}

function ok<T>(value: T): FileResult<T> {
  return { ok: true, value }
}

const NOT_FOUND = { ok: false, kind: 'not-found', message: 'missing' } as const

/** An in-memory stand-in for the platform file helpers, keyed by path. */
export function memory(fail: { readonly append?: boolean } = {}) {
  const store = new Map<string, string>()
  const files: IncidentFiles = {
    append: (path, text) => {
      if (fail.append === true) return Promise.resolve({ ok: false, kind: 'io', message: 'disk full' })
      store.set(path, (store.get(path) ?? '') + text)
      return Promise.resolve(ok(undefined))
    },
    stat: (path) => {
      const text = store.get(path)
      return Promise.resolve(text === undefined ? NOT_FOUND : ok({ kind: 'file', size: Buffer.byteLength(text), modifiedAt: 'x' }))
    },
    readLines: (path) => {
      const text = store.get(path)
      if (text === undefined) return Promise.resolve(NOT_FOUND)
      return Promise.resolve(ok({ lines: text.split('\n').slice(0, -1), bytesConsumed: Buffer.byteLength(text), filledBudget: false }))
    },
    readJson: (path) => {
      const text = store.get(path)
      return Promise.resolve(text === undefined ? NOT_FOUND : ok(JSON.parse(text) as never))
    },
    writeText: (path, text) => {
      store.set(path, text)
      return Promise.resolve(ok(undefined))
    },
    writeJson: (path, value) => {
      store.set(path, JSON.stringify(value))
      return Promise.resolve(ok(undefined))
    },
    rename: (from, to) => {
      store.set(to, store.get(from) ?? '')
      store.delete(from)
      return Promise.resolve(ok(undefined))
    },
  }
  return { store, files }
}

function stored(number: number): StoredItem {
  return { kind: 'pull-request', number, keys: ['readyForReview'], marked: true, autoPlan: false, claimedAt: null, reviewCycles: 0, history: [], updatedAt: '2026-01-01T00:00:00.000Z', issue: null, mirrorFailure: null }
}

interface WriterRigOptions {
  readonly number: number
  /** The head GitHub reports when the write reads the item. */
  readonly writeHead: string
}

/** A real `writeState` over an in-memory store, with every incident it raises collected. */
export function writerRig(options: WriterRigOptions) {
  const incidents: IncidentDraft[] = []
  let record: RepoRecord = { seededAt: 't', heldBy: null, items: { [itemKey('pull-request', options.number)]: stored(options.number) } }
  const store = {
    view: () => viewOf(record),
    transition: vi.fn((_id: RepoId, ref: { kind: 'issue' | 'pull-request'; number: number }, input: Parameters<PipelineStateStore['transition']>[2]) => {
      const next = transition(record, ref, input)
      if (!next.ok) return Promise.resolve(next)
      record = withItem(record, next.item)
      return Promise.resolve({ ok: true as const, changed: next.changed })
    }),
    recordMirror: vi.fn((_id: RepoId, ref: { kind: 'issue' | 'pull-request'; number: number }, failure: MirrorFailure | null) => {
      record = recordMirror(record, ref, failure)
      return Promise.resolve()
    }),
  }
  const writer = createStateWriter({
    store: store as unknown as PipelineStateStore,
    applyLabels: (): Promise<WriteOutcome> => Promise.resolve({ kind: 'applied', argv: ['edit'] }),
    readOwnership: () => Promise.resolve({ kind: 'app', since: 's', path: 'p', readAt: 'r' }),
    fetchItemsByNumber: ({ numbers }) =>
      Promise.resolve({
        ok: true,
        resolved: numbers.map((number) => ({ number, kind: 'pull-request' as const, state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: [], assignees: ['op'], headRefName: `${String(number)}-x`, headRefOid: options.writeHead, author: null })),
        unavailable: [],
        fetchedAt: 'r',
      }),
    appendAudit: () => Promise.resolve(),
    recordIncident: (draft) => Promise.resolve(void incidents.push(draft)),
    newId: () => 'write-1',
    now: () => new Date('2026-11-16T12:00:00.000Z'),
  })
  return { ...writer, incidents }
}
