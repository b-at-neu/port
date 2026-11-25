import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { LabelVocabulary } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'
import type { WriteOutcome } from '@/types/writes'
import { escalateToHuman } from '@/main/pipeline/operator/escalate'
import type { EscalateToHumanDeps } from '@/main/pipeline/operator/escalate'
import type { EscalateToHumanParams } from '@/types/actions'
import type { ReadyEntry } from '@/types/actions'

const REPO_ID = 'repo-1' as unknown as RepoId
const VOCABULARY: LabelVocabulary = resolveVocabulary({})

const ENTRY: ReadyEntry = {
  id: REPO_ID,
  path: '/repo',
  displayName: 'widgets',
  status: 'ready',
  config: {
    repo: 'acme/widgets',
    owner: 'acme',
    name: 'widgets',
    branches: { integration: 'dev', production: 'main' },
    models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
    modules: { approvalGate: true, release: true, scope: true },
    reviewCycleCap: 3,
    vocabulary: VOCABULARY,
    commands: { worktrees: null, budget: null },
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
    sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
    checkDispositions: {},
    overrides: [],
  },
  diagnostics: [],
}

function params(overrides: Partial<EscalateToHumanParams> = {}): EscalateToHumanParams {
  return {
    entry: ENTRY,
    kind: 'issue',
    number: 52,
    trigger: 'planApproved',
    viewer: 'op',
    body: '## Pipeline Escalation\nover budget',
    action: 'budget-escalate',
    auditDir: '/audit',
    scratchDir: '/scratch',
    ...overrides,
  }
}

describe('escalateToHuman', () => {
  it('swaps the label first, then comments — both applied', async () => {
    const calls: string[] = []
    const deps: EscalateToHumanDeps = {
      writeState: (p) => {
        calls.push('applyLabels')
        expect(p.request.add).toEqual(['needsHuman'])
        expect(p.request.remove).toEqual(['planApproved'])
        expect(p.request.expect).toEqual({ present: ['planApproved'], absent: ['needsHuman'], assignees: { kind: 'exactly', logins: ['op'] } })
        return Promise.resolve({ kind: 'applied', argv: [] } satisfies WriteOutcome)
      },
      postComment: (p) => {
        calls.push('postComment')
        expect(p.request.body).toContain('over budget')
        return Promise.resolve({ kind: 'applied', argv: [] } satisfies WriteOutcome)
      },
    }
    const result = await escalateToHuman(params(), deps)
    expect(calls).toEqual(['applyLabels', 'postComment'])
    expect(result.labels.kind).toBe('applied')
    expect(result.comment?.kind).toBe('applied')
  })

  it('comments when the state moved but its label mirror failed, and stays quiet when the state did not save', async () => {
    const posted: string[] = []
    const postComment: EscalateToHumanDeps['postComment'] = () => (posted.push('comment'), Promise.resolve({ kind: 'applied', argv: [] } satisfies WriteOutcome))
    const mirror: WriteOutcome = { kind: 'mirror-failed', mirror: { kind: 'write-failed', classification: 'network', stderr: 'offline', reread: null } }
    const moved = await escalateToHuman(params(), { writeState: () => Promise.resolve(mirror), postComment })
    expect(moved.labels.kind).toBe('mirror-failed')
    expect(moved.comment?.kind).toBe('applied')

    const unsaved = await escalateToHuman(params(), { writeState: () => Promise.resolve({ kind: 'state-unsaved', message: 'disk full' }), postComment })
    expect(unsaved.comment).toBeNull()
    expect(posted).toEqual(['comment'])
  })

  it('never comments when the label swap does not apply', async () => {
    let commentCalled = false
    const deps: EscalateToHumanDeps = {
      writeState: () => Promise.resolve({ kind: 'ownership-unreadable', path: '/repo/.agents/cockpit.json', message: 'bad' } satisfies WriteOutcome),
      postComment: () => {
        commentCalled = true
        return Promise.resolve({ kind: 'applied', argv: [] } satisfies WriteOutcome)
      },
    }
    const result = await escalateToHuman(params(), deps)
    expect(commentCalled).toBe(false)
    expect(result.comment).toBeNull()
    expect(result.labels.kind).toBe('ownership-unreadable')
  })

  it('swaps the label and posts nothing when the body is null', async () => {
    let commentCalled = false
    const deps: EscalateToHumanDeps = {
      writeState: () => Promise.resolve({ kind: 'applied', argv: [] } satisfies WriteOutcome),
      postComment: () => {
        commentCalled = true
        return Promise.resolve({ kind: 'applied', argv: [] } satisfies WriteOutcome)
      },
    }
    const result = await escalateToHuman(params({ body: null }), deps)
    expect(commentCalled).toBe(false)
    expect(result.comment).toBeNull()
    expect(result.labels.kind).toBe('applied')
  })

  it('reports a failed comment without discarding the successful swap', async () => {
    const deps: EscalateToHumanDeps = {
      writeState: () => Promise.resolve({ kind: 'applied', argv: [] } satisfies WriteOutcome),
      postComment: () => Promise.resolve({ kind: 'write-failed', classification: 'unknown', stderr: 'boom', reread: null } satisfies WriteOutcome),
    }
    const result = await escalateToHuman(params(), deps)
    expect(result.labels.kind).toBe('applied')
    expect(result.comment?.kind).toBe('write-failed')
  })
})
