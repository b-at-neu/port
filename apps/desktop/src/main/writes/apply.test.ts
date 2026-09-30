import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import type { LabelVocabulary } from '../../shared/labels/vocabulary'
import type { RepoId } from '../../shared/repos'
import type { CommentRequest, LabelWriteRequest, WriteOutcome } from '../../shared/writes/types'
import type { CommandResult } from '../platform'
import type { GhResult } from '../platform/gh'
import type { ItemsByNumberFetch, ResolvedItem } from '../github'
import { applyLabels, postComment } from './apply'
import type { GhRunner } from './apply'
import { readAuditLog } from './audit'
import { takeGateClaim } from './claim'
import type { GitRunner } from './claim'

const VOCABULARY: LabelVocabulary = resolveVocabulary({})
const REPO_ID = 'repo-1' as unknown as RepoId
const NOT_A_REPO: CommandResult = { ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'fatal: not a git repository' }
const now = () => new Date('2026-01-01T00:00:00.000Z')

async function makeDirs(): Promise<{ readonly repoRoot: string; readonly auditDir: string; readonly git: GitRunner }> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'port-writes-apply-repo-'))
  const auditDir = await mkdtemp(join(tmpdir(), 'port-writes-apply-audit-'))
  const git: GitRunner = () => Promise.resolve(NOT_A_REPO) // degrades to repoRoot itself
  return { repoRoot, auditDir, git }
}

function request(overrides: Partial<LabelWriteRequest> = {}): LabelWriteRequest {
  return {
    repoId: REPO_ID,
    repo: 'o/r',
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

function resolvedItem(overrides: Partial<ResolvedItem> = {}): ResolvedItem {
  return { number: 1, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: [], assignees: [], ...overrides }
}

function fetcherReturning(fetch: ItemsByNumberFetch): { readonly fn: (params: unknown) => Promise<ItemsByNumberFetch>; calls: number } {
  const state = { calls: 0 }
  const fn = () => {
    state.calls++
    return Promise.resolve(fetch)
  }
  return {
    fn,
    get calls() {
      return state.calls
    },
  }
}

function neverCalledGh(): GhRunner {
  return () => {
    throw new Error('gh should not have been called')
  }
}

describe('applyLabels — the plan-gate claim', () => {
  it('refuses with unclaimed-scope when no claim file exists', async () => {
    const { repoRoot, auditDir, git } = await makeDirs()
    const req = request({ add: ['planApproved'], remove: ['planReview'], expect: { present: ['planReview'], absent: [], assignees: { kind: 'any' } } })
    const gh = neverCalledGh()
    const fetcher = fetcherReturning({ ok: true, resolved: [], unavailable: [], fetchedAt: now().toISOString() })

    const outcome = await applyLabels({ request: req, repoRoot, auditDir, git, gh, fetchItemsByNumber: fetcher.fn, now })
    expect(outcome.kind).toBe('unclaimed-scope')
    expect(fetcher.calls).toBe(0)

    const log = await readAuditLog(auditDir)
    if (!log.ok) throw new Error('unreachable')
    expect(log.entries).toHaveLength(1)
    expect(log.entries[0]?.claim).toBe('absent')
    expect(log.entries[0]?.result.kind).toBe('unclaimed-scope')
  })

  it('refuses with claim-unreadable for malformed claim JSON', async () => {
    const { repoRoot, auditDir, git } = await makeDirs()
    await mkdir(join(repoRoot, '.agents'), { recursive: true })
    await writeFile(join(repoRoot, '.agents', 'gate-claim.json'), '{not json', 'utf8')

    const req = request({ add: ['planApproved'], remove: ['planReview'], expect: { present: ['planReview'], absent: [], assignees: { kind: 'any' } } })
    const gh = neverCalledGh()
    const outcome = await applyLabels({ request: req, repoRoot, auditDir, git, gh, now })
    expect(outcome.kind).toBe('claim-unreadable')

    const log = await readAuditLog(auditDir)
    if (!log.ok) throw new Error('unreachable')
    expect(log.entries[0]?.claim).toBe('unreadable')
  })

  it('proceeds to a real write once the scope is held', async () => {
    const { repoRoot, auditDir, git } = await makeDirs()
    await takeGateClaim({ repoRoot, repo: 'o/r', owner: 'port-desktop', scopes: ['plan-gate'], git, now })

    const req = request({ add: ['planApproved'], remove: ['planReview'], expect: { present: ['planReview'], absent: [], assignees: { kind: 'any' } } })
    const fetcher = fetcherReturning({ ok: true, resolved: [resolvedItem({ labels: ['plan review'] })], unavailable: [], fetchedAt: now().toISOString() })
    let ghCalled: readonly string[] | undefined
    const gh: GhRunner = (args) => {
      ghCalled = args
      return Promise.resolve({ ok: true, stdout: '', stderr: '' } satisfies GhResult)
    }

    const outcome = await applyLabels({ request: req, repoRoot, auditDir, git, gh, fetchItemsByNumber: fetcher.fn, now })
    expect(outcome).toEqual({ kind: 'applied', argv: ghCalled })
    expect(ghCalled).toEqual(['issue', 'edit', '1', '--repo', 'o/r', '--add-label', 'plan approved', '--remove-label', 'plan review'])
  })
})

describe('applyLabels — convergent writes need no claim', () => {
  it('applies a ready/blocked swap with no claim file present', async () => {
    const { repoRoot, auditDir, git } = await makeDirs()
    const req = request({ add: ['ready'], remove: ['blocked'] })
    const fetcher = fetcherReturning({ ok: true, resolved: [resolvedItem({ labels: ['blocked'] })], unavailable: [], fetchedAt: now().toISOString() })
    const gh: GhRunner = () => Promise.resolve({ ok: true, stdout: '', stderr: '' } satisfies GhResult)

    const outcome = await applyLabels({ request: req, repoRoot, auditDir, git, gh, fetchItemsByNumber: fetcher.fn, now })
    expect(outcome.kind).toBe('applied')

    const log = await readAuditLog(auditDir)
    if (!log.ok) throw new Error('unreachable')
    expect(log.entries[0]?.scope).toBe(null)
    expect(log.entries[0]?.claim).toBe('not-required')
  })
})

describe('applyLabels — precondition', () => {
  it('reports precondition-failed with both name readings when it is violated', async () => {
    const { repoRoot, auditDir, git } = await makeDirs()
    const req = request({ add: ['blocked'], expect: { present: ['ready'], absent: [], assignees: { kind: 'any' } } })
    const fetcher = fetcherReturning({ ok: true, resolved: [resolvedItem({ labels: ['in progress'] })], unavailable: [], fetchedAt: '2026-01-02T00:00:00Z' })
    const gh = neverCalledGh()

    const outcome = await applyLabels({ request: req, repoRoot, auditDir, git, gh, fetchItemsByNumber: fetcher.fn, now })
    expect(outcome.kind).toBe('precondition-failed')
    if (outcome.kind !== 'precondition-failed') return
    expect(outcome.conflict).toEqual({ kind: 'precondition-failed', expected: ['ready'], observed: ['in progress'], readAt: '2026-01-02T00:00:00Z' })
  })
})

describe('applyLabels — no-op', () => {
  it('makes no gh call when the requested state already holds', async () => {
    const { repoRoot, auditDir, git } = await makeDirs()
    const req = request({ add: ['ready'] })
    const fetcher = fetcherReturning({ ok: true, resolved: [resolvedItem({ labels: ['ready'] })], unavailable: [], fetchedAt: now().toISOString() })
    const gh = neverCalledGh()

    const outcome = await applyLabels({ request: req, repoRoot, auditDir, git, gh, fetchItemsByNumber: fetcher.fn, now })
    expect(outcome).toEqual({ kind: 'no-op' })
  })
})

describe('applyLabels — an unknown label at gh', () => {
  it('surfaces gh stderr verbatim in write-failed, with a best-effort re-read', async () => {
    const { repoRoot, auditDir, git } = await makeDirs()
    const req = request({ add: ['ready'] })
    let calls = 0
    const fetchItemsByNumber = (): Promise<ItemsByNumberFetch> => {
      calls++
      return Promise.resolve({ ok: true, resolved: [resolvedItem({ labels: [] })], unavailable: [], fetchedAt: now().toISOString() })
    }
    const gh: GhRunner = () => Promise.resolve({ ok: false, kind: 'unknown', stdout: '', stderr: "gh: label 'ready' not found" } satisfies GhResult)

    const outcome: WriteOutcome = await applyLabels({ request: req, repoRoot, auditDir, git, gh, fetchItemsByNumber, now })
    expect(outcome.kind).toBe('write-failed')
    if (outcome.kind !== 'write-failed') return
    expect(outcome.stderr).toBe("gh: label 'ready' not found")
    expect(calls).toBe(2) // the verify read, then the best-effort re-read
  })
})

describe('applyLabels — unresolvable-label', () => {
  it('aborts before any gh or verify call for a module-disabled or unknown key', async () => {
    const { repoRoot, auditDir, git } = await makeDirs()
    const emptyVocabulary: LabelVocabulary = { labels: [], disabled: [], problems: [] }
    const req = request({ vocabulary: emptyVocabulary, add: ['ready'] })
    const gh = neverCalledGh()
    const fetcher = fetcherReturning({ ok: true, resolved: [], unavailable: [], fetchedAt: now().toISOString() })

    const outcome = await applyLabels({ request: req, repoRoot, auditDir, git, gh, fetchItemsByNumber: fetcher.fn, now })
    expect(outcome).toEqual({ kind: 'unresolvable-label', keys: ['ready'] })
    expect(fetcher.calls).toBe(0)
  })
})

function commentRequest(overrides: Partial<CommentRequest> = {}): CommentRequest {
  return { repoId: REPO_ID, repo: 'o/r', kind: 'issue', number: 1, body: 'hello', action: 'test comment', scratchDir: '', ...overrides }
}

describe('postComment', () => {
  it('writes the body to a scratch file, passes --body-file, and deletes it afterwards', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'port-writes-comment-'))
    const auditDir = await mkdtemp(join(tmpdir(), 'port-writes-apply-audit-'))
    let bodyFileContent: string | undefined
    const gh: GhRunner = async (args) => {
      const idx = args.indexOf('--body-file')
      const path = args[idx + 1]
      if (path) bodyFileContent = await readFile(path, 'utf8')
      return { ok: true, stdout: '', stderr: '' } satisfies GhResult
    }

    const outcome = await postComment({ request: commentRequest({ scratchDir, body: 'a comment body' }), auditDir, gh, now })
    expect(outcome.kind).toBe('applied')
    expect(bodyFileContent).toBe('a comment body')

    const remaining = await readdir(scratchDir)
    expect(remaining).toEqual([])
  })

  it('audits byte length and target, never the comment text', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'port-writes-comment-'))
    const auditDir = await mkdtemp(join(tmpdir(), 'port-writes-apply-audit-'))
    const gh: GhRunner = () => Promise.resolve({ ok: true, stdout: '', stderr: '' } satisfies GhResult)

    await postComment({ request: commentRequest({ scratchDir, body: 'secret content' }), auditDir, gh, now })

    const log = await readAuditLog(auditDir)
    if (!log.ok) throw new Error('unreachable')
    expect(log.entries).toHaveLength(1)
    expect(log.entries[0]?.commentBytes).toBe(Buffer.byteLength('secret content', 'utf8'))
    expect(JSON.stringify(log.entries[0])).not.toContain('secret content')
  })

  it('deletes the scratch file even when gh fails', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'port-writes-comment-'))
    const auditDir = await mkdtemp(join(tmpdir(), 'port-writes-apply-audit-'))
    const gh: GhRunner = () => Promise.resolve({ ok: false, kind: 'unknown', stdout: '', stderr: 'boom' } satisfies GhResult)

    const outcome = await postComment({ request: commentRequest({ scratchDir }), auditDir, gh, now })
    expect(outcome.kind).toBe('write-failed')
    if (outcome.kind !== 'write-failed') return
    expect(outcome.stderr).toBe('boom')

    const remaining = await readdir(scratchDir)
    expect(remaining).toEqual([])
  })
})
