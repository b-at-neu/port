// Shared rigs for the incident tests: a reconciled item and a test context whose writer runs over a fake GitHub.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReadyEntry } from '@/types/actions'
import type { IncidentDraft } from '@/types/incidents'
import type { ReconciledItem } from '@/types/state'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'
import { createTestContext } from '../../../support/context'
import { createFakeGitHub } from '../../../support/fake-github'
import { AT } from '../../../support/state-store'
import { ticketOf } from '../../../support/tickets'

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

interface WriterRigOptions {
  readonly number: number
  /** The head GitHub reports when the write reads the item. */
  readonly writeHead: string
}

/** A test context over a fake GitHub and a seeded record store, with every incident the writer raises collected. */
export async function writerRig(options: WriterRigOptions) {
  const incidents: IncidentDraft[] = []
  const github = createFakeGitHub({ items: [{ number: options.number, kind: 'pull-request', assignees: ['op'], headRefName: `${String(options.number)}-x`, headRefOid: options.writeHead }] })
  const incidentLog = { record: (draft: IncidentDraft) => Promise.resolve(void incidents.push(draft)), read: () => Promise.resolve({ ok: true as const, records: [], malformed: 0, pruned: null, readAt: AT }) }
  const ticket = ticketOf({ repo: REPO_ID, ticket: options.number, pr: { number: options.number, approvedAt: null }, stage: 'review', status: { kind: 'queued', reason: 'new', since: AT } })
  const ctx = createTestContext({ platform: github.platform, tickets: { repoId: REPO_ID, tickets: [ticket] }, stores: { incidentLog } })
  await ctx.ready
  const auditDir = await mkdtemp(join(tmpdir(), 'port-incident-'))
  return { ctx, incidents, auditDir }
}
