import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import type { LabelVocabulary } from '../../shared/labels/vocabulary'
import type { RepoId } from '../../shared/repos'
import type { WriteOutcome } from '../../shared/writes/types'
import { escalateToHuman } from './escalate'
import type { EscalateToHumanDeps, EscalateToHumanParams } from './escalate'
import type { ReadyEntry } from './apply'

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
      applyLabels: (p) => {
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

  it('never comments when the label swap does not apply', async () => {
    let commentCalled = false
    const deps: EscalateToHumanDeps = {
      applyLabels: () => Promise.resolve({ kind: 'terminal-owned', since: '2026-01-01T00:00:00Z' } satisfies WriteOutcome),
      postComment: () => {
        commentCalled = true
        return Promise.resolve({ kind: 'applied', argv: [] } satisfies WriteOutcome)
      },
    }
    const result = await escalateToHuman(params(), deps)
    expect(commentCalled).toBe(false)
    expect(result.comment).toBeNull()
    expect(result.labels.kind).toBe('terminal-owned')
  })

  it('reports a failed comment without discarding the successful swap', async () => {
    const deps: EscalateToHumanDeps = {
      applyLabels: () => Promise.resolve({ kind: 'applied', argv: [] } satisfies WriteOutcome),
      postComment: () => Promise.resolve({ kind: 'write-failed', classification: 'unknown', stderr: 'boom', reread: null } satisfies WriteOutcome),
    }
    const result = await escalateToHuman(params(), deps)
    expect(result.labels.kind).toBe('applied')
    expect(result.comment?.kind).toBe('write-failed')
  })
})
