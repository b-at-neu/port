import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import type { RepoId } from '../../shared/repos'
import type { LabelWriteRequest } from '../../shared/writes/types'
import { applyClaimLabels } from './claim'

const VOCABULARY = resolveVocabulary({})
const REPO_ID = 'repo-1' as unknown as RepoId

function request(overrides: Partial<LabelWriteRequest> = {}): LabelWriteRequest {
  return {
    repoId: REPO_ID,
    repo: 'acme/widgets',
    kind: 'issue',
    number: 1,
    vocabulary: VOCABULARY,
    add: [],
    remove: [],
    addAssignees: [],
    removeAssignees: [],
    expect: { present: [], absent: [], assignees: { kind: 'any' } },
    action: 'test',
    ...overrides,
  }
}

describe('applyClaimLabels', () => {
  it('forwards unchanged to writes/applyLabels — a no-op request needs no gh call at all', async () => {
    const auditDir = await mkdtemp(join(tmpdir(), 'port-actions-claim-'))
    const outcome = await applyClaimLabels({
      request: request({ add: ['ready'] }),
      repoRoot: '/repo',
      auditDir,
      gh: () => {
        throw new Error('gh should not be invoked for a no-op request')
      },
      fetchItemsByNumber: () =>
        Promise.resolve({
          ok: true,
          resolved: [{ number: 1, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: ['ready'], assignees: [] }],
          unavailable: [],
          fetchedAt: '2026-01-01T00:00:00.000Z',
        }),
    })
    expect(outcome).toEqual({ kind: 'no-op' })
  })
})
