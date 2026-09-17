import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import type { AuditEntry, AuditRead } from '../../shared/writes/types'
import type { RepoId } from '../../shared/repos'
import { recoverPausedTrigger } from './resume'

const VOCABULARY = resolveVocabulary({})

function pauseEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    at: '2026-01-01T00:00:00Z',
    repo: 'o/r',
    repoId: 'repo-a' as RepoId,
    kind: 'issue',
    number: 148,
    action: 'pause',
    scope: null,
    claim: 'not-required',
    precondition: { present: ['plan approved'], absent: [], assignees: { kind: 'any' } },
    observed: null,
    call: [],
    commentBytes: null,
    result: { kind: 'applied', argv: [] },
    ...overrides,
  }
}

function fakeRead(entries: readonly AuditEntry[]): (dir: string, params: { readonly repo?: string; readonly number?: number }) => Promise<AuditRead> {
  return () => Promise.resolve({ ok: true, entries, malformed: 0, previousPath: null, readAt: '2026-01-01T00:00:00Z' })
}

describe('recoverPausedTrigger', () => {
  it('recovers the trigger off the last applied pause entry', async () => {
    const result = await recoverPausedTrigger({
      auditDir: '/tmp/audit',
      repo: 'o/r',
      number: 148,
      vocabulary: VOCABULARY,
      readAuditLog: fakeRead([pauseEntry()]),
    })
    expect(result).toEqual({ kind: 'recovered', trigger: 'planApproved' })
  })

  it('picks the newest matching entry, not the first, among several pauses', async () => {
    const entries = [
      pauseEntry({ precondition: { present: ['ready'], absent: [], assignees: { kind: 'any' } } }),
      pauseEntry({ precondition: { present: ['plan approved'], absent: [], assignees: { kind: 'any' } } }),
    ]
    const result = await recoverPausedTrigger({ auditDir: '/tmp/audit', repo: 'o/r', number: 148, vocabulary: VOCABULARY, readAuditLog: fakeRead(entries) })
    expect(result).toEqual({ kind: 'recovered', trigger: 'planApproved' })
  })

  it('ignores a pause entry whose result is not applied', async () => {
    const entries = [pauseEntry({ result: { kind: 'no-op' } })]
    const result = await recoverPausedTrigger({ auditDir: '/tmp/audit', repo: 'o/r', number: 148, vocabulary: VOCABULARY, readAuditLog: fakeRead(entries) })
    expect(result).toEqual({ kind: 'no-record' })
  })

  it('ignores a non-pause action even when applied', async () => {
    const entries = [pauseEntry({ action: 'retry' })]
    const result = await recoverPausedTrigger({ auditDir: '/tmp/audit', repo: 'o/r', number: 148, vocabulary: VOCABULARY, readAuditLog: fakeRead(entries) })
    expect(result).toEqual({ kind: 'no-record' })
  })

  it('reports no-record when there is no entry at all', async () => {
    const result = await recoverPausedTrigger({ auditDir: '/tmp/audit', repo: 'o/r', number: 148, vocabulary: VOCABULARY, readAuditLog: fakeRead([]) })
    expect(result).toEqual({ kind: 'no-record' })
  })

  it('reports no-record when the audit log itself could not be read — an unreadable log proves nothing', async () => {
    const result = await recoverPausedTrigger({
      auditDir: '/tmp/audit',
      repo: 'o/r',
      number: 148,
      vocabulary: VOCABULARY,
      readAuditLog: () => Promise.resolve({ ok: false, kind: 'permission-denied', message: 'nope', readAt: '2026-01-01T00:00:00Z' }),
    })
    expect(result).toEqual({ kind: 'no-record' })
  })

  it('reports unresolvable when the recorded name no longer resolves to a key', async () => {
    const entries = [pauseEntry({ precondition: { present: ['a since-renamed label'], absent: [], assignees: { kind: 'any' } } })]
    const result = await recoverPausedTrigger({ auditDir: '/tmp/audit', repo: 'o/r', number: 148, vocabulary: VOCABULARY, readAuditLog: fakeRead(entries) })
    expect(result).toEqual({ kind: 'unresolvable' })
  })
})
