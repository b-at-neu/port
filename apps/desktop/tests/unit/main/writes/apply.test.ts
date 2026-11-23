import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { ApplyLabelsParams, AuditEntry, CommentRequest, LabelAuditEntry, ObservedItem, WriteOutcome } from '@/types/writes'
import { isLabelAuditEntry } from '@/types/writes'
import type { CommandResult } from '@/types/platform'
import type { GhResult } from '@/types/platform'
import type { ItemsByNumberFetch, ResolvedItem } from '@/types/github'
import { applyLabels, postComment, postIssueBody } from '@/main/github/writes/apply'
import type { GhRunner, GitRunner } from '@/types/platform'
import { readAuditLog } from '@/main/github/writes/audit'
import { takeOwnership } from '@/main/repos/ownership'

const REPO_ID = 'repo-1' as unknown as RepoId
const NOT_A_REPO: CommandResult = { ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'fatal: not a git repository' }
const now = () => new Date('2026-01-01T00:00:00.000Z')

async function makeDirs(): Promise<{ readonly repoRoot: string; readonly auditDir: string; readonly git: GitRunner }> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'port-writes-apply-repo-'))
  const auditDir = await mkdtemp(join(tmpdir(), 'port-writes-apply-audit-'))
  const git: GitRunner = () => Promise.resolve(NOT_A_REPO) // degrades to repoRoot itself
  return { repoRoot, auditDir, git }
}

function observedOf(labels: readonly string[] = [], assignees: readonly string[] = []): ObservedItem {
  return { labels, assignees, readAt: '2026-01-01T00:00:00.000Z' }
}

function params(dirs: { readonly repoRoot: string; readonly auditDir: string; readonly git: GitRunner }, overrides: Partial<ApplyLabelsParams> = {}): ApplyLabelsParams {
  return {
    repo: 'o/r',
    repoId: REPO_ID,
    kind: 'issue',
    number: 1,
    action: 'test',
    addNames: [],
    removeNames: [],
    addAssignees: [],
    removeAssignees: [],
    observed: observedOf(),
    now,
    ...dirs,
    ...overrides,
  }
}

function labelEntry(entry: AuditEntry | undefined): LabelAuditEntry {
  if (entry === undefined || !isLabelAuditEntry(entry)) throw new Error('unreachable: expected a label audit entry')
  return entry
}

function resolvedItem(overrides: Partial<ResolvedItem> = {}): ResolvedItem {
  return { number: 1, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: 't', url: 'u', labels: [], assignees: [], headRefName: null, author: null, ...overrides }
}

function neverCalledGh(): GhRunner {
  return () => {
    throw new Error('gh should not have been called')
  }
}

describe('applyLabels — ownership', () => {
  it('refuses a record naming the terminal cockpit as unreadable, even for a convergent write', async () => {
    const { repoRoot, auditDir, git } = await makeDirs()
    await mkdir(join(repoRoot, '.agents'), { recursive: true })
    await writeFile(join(repoRoot, '.agents', 'cockpit.json'), JSON.stringify({ repo: 'o/r', owner: 'terminal', since: '2026-01-01T00:00:00Z' }), 'utf8')

    const gh = neverCalledGh()

    const outcome = await applyLabels(params({ repoRoot, auditDir, git }, { addNames: ['ready'], removeNames: ['blocked'], gh }))
    expect(outcome.kind).toBe('ownership-unreadable')

    const log = await readAuditLog(auditDir)
    if (!log.ok) throw new Error('unreachable')
    expect(log.entries).toHaveLength(1)
    expect(labelEntry(log.entries[0]).ownership).toBe('unreadable')
    expect(labelEntry(log.entries[0]).result.kind).toBe('ownership-unreadable')
  })

  it('refuses with ownership-unreadable for malformed cockpit.json', async () => {
    const { repoRoot, auditDir, git } = await makeDirs()
    await mkdir(join(repoRoot, '.agents'), { recursive: true })
    await writeFile(join(repoRoot, '.agents', 'cockpit.json'), '{not json', 'utf8')

    const outcome = await applyLabels(params({ repoRoot, auditDir, git }, { addNames: ['ready'], removeNames: ['blocked'], gh: neverCalledGh() }))
    expect(outcome.kind).toBe('ownership-unreadable')

    const log = await readAuditLog(auditDir)
    if (!log.ok) throw new Error('unreachable')
    expect(labelEntry(log.entries[0]).ownership).toBe('unreadable')
  })

  it('proceeds to a real write while this app owns the repo', async () => {
    const { repoRoot, auditDir, git } = await makeDirs()
    await takeOwnership({ repoRoot, repo: 'o/r', git, now })

    let ghCalled: readonly string[] | undefined
    const gh: GhRunner = (args) => {
      ghCalled = args
      return Promise.resolve({ ok: true, stdout: '', stderr: '' } satisfies GhResult)
    }

    const outcome = await applyLabels(params({ repoRoot, auditDir, git }, { addNames: ['plan approved'], removeNames: ['plan review'], observed: observedOf(['plan review']), gh }))
    expect(outcome).toEqual({ kind: 'applied', argv: ghCalled })
    expect(ghCalled).toEqual(['issue', 'edit', '1', '--repo', 'o/r', '--add-label', 'plan approved', '--remove-label', 'plan review'])

    const log = await readAuditLog(auditDir)
    if (!log.ok) throw new Error('unreachable')
    expect(labelEntry(log.entries[0]).ownership).toBe('app')
  })

  it('proceeds to a real write when nobody owns the repo yet', async () => {
    const { repoRoot, auditDir, git } = await makeDirs()
    const gh: GhRunner = () => Promise.resolve({ ok: true, stdout: '', stderr: '' } satisfies GhResult)

    const outcome = await applyLabels(params({ repoRoot, auditDir, git }, { addNames: ['ready'], removeNames: ['blocked'], observed: observedOf(['blocked']), gh }))
    expect(outcome.kind).toBe('applied')

    const log = await readAuditLog(auditDir)
    if (!log.ok) throw new Error('unreachable')
    expect(labelEntry(log.entries[0]).ownership).toBe('absent')
  })
})

describe('applyLabels — no precondition', () => {
  it('writes the names it was given without reading the item or comparing labels', async () => {
    const { repoRoot, auditDir, git } = await makeDirs()
    let reads = 0
    const fetchItemsByNumber = (): Promise<ItemsByNumberFetch> => {
      reads++
      return Promise.resolve({ ok: true, resolved: [], unavailable: [], fetchedAt: now().toISOString() })
    }
    const gh: GhRunner = () => Promise.resolve({ ok: true, stdout: '', stderr: '' } satisfies GhResult)

    const outcome = await applyLabels(params({ repoRoot, auditDir, git }, { addNames: ['blocked'], observed: observedOf(['in progress']), gh, fetchItemsByNumber }))
    expect(outcome.kind).toBe('applied')
    expect(reads).toBe(0)

    const log = await readAuditLog(auditDir)
    if (!log.ok) throw new Error('unreachable')
    expect(labelEntry(log.entries[0])).toMatchObject({ precondition: null, observed: { labels: ['in progress'] } })
  })
})

describe('applyLabels — no-op', () => {
  it('makes no gh call when the requested state already holds', async () => {
    const { repoRoot, auditDir, git } = await makeDirs()
    const outcome = await applyLabels(params({ repoRoot, auditDir, git }, { addNames: ['ready'], observed: observedOf(['ready']), gh: neverCalledGh() }))
    expect(outcome).toEqual({ kind: 'no-op' })
  })
})

describe('applyLabels — an unknown label at gh', () => {
  it('surfaces gh stderr verbatim in write-failed, with one best-effort re-read', async () => {
    const { repoRoot, auditDir, git } = await makeDirs()
    let calls = 0
    const fetchItemsByNumber = (): Promise<ItemsByNumberFetch> => {
      calls++
      return Promise.resolve({ ok: true, resolved: [resolvedItem({ labels: [] })], unavailable: [], fetchedAt: now().toISOString() })
    }
    const gh: GhRunner = () => Promise.resolve({ ok: false, kind: 'unknown', stdout: '', stderr: "gh: label 'ready' not found" } satisfies GhResult)

    const outcome: WriteOutcome = await applyLabels(params({ repoRoot, auditDir, git }, { addNames: ['ready'], gh, fetchItemsByNumber }))
    expect(outcome.kind).toBe('write-failed')
    if (outcome.kind !== 'write-failed') return
    expect(outcome.stderr).toBe("gh: label 'ready' not found")
    expect(calls).toBe(1)
  })
})

function commentRequest(overrides: Partial<CommentRequest> = {}): CommentRequest {
  return { repoId: REPO_ID, repo: 'o/r', kind: 'issue', number: 1, body: 'hello', action: 'test comment', scratchDir: '', ...overrides }
}

describe('postComment', () => {
  it('writes the body to a scratch file, passes --body-file, and deletes it afterwards', async () => {
    const { repoRoot } = await makeDirs()
    const scratchDir = await mkdtemp(join(tmpdir(), 'port-writes-comment-'))
    const auditDir = await mkdtemp(join(tmpdir(), 'port-writes-apply-audit-'))
    let bodyFileContent: string | undefined
    const gh: GhRunner = async (args) => {
      const idx = args.indexOf('--body-file')
      const path = args[idx + 1]
      if (path) bodyFileContent = await readFile(path, 'utf8')
      return { ok: true, stdout: '', stderr: '' } satisfies GhResult
    }

    const outcome = await postComment({ request: commentRequest({ scratchDir, body: 'a comment body' }), repoRoot, auditDir, gh, now })
    expect(outcome.kind).toBe('applied')
    expect(bodyFileContent).toBe('a comment body')

    const remaining = await readdir(scratchDir)
    expect(remaining).toEqual([])
  })

  it('audits byte length and target, never the comment text', async () => {
    const { repoRoot } = await makeDirs()
    const scratchDir = await mkdtemp(join(tmpdir(), 'port-writes-comment-'))
    const auditDir = await mkdtemp(join(tmpdir(), 'port-writes-apply-audit-'))
    const gh: GhRunner = () => Promise.resolve({ ok: true, stdout: '', stderr: '' } satisfies GhResult)

    await postComment({ request: commentRequest({ scratchDir, body: 'secret content' }), repoRoot, auditDir, gh, now })

    const log = await readAuditLog(auditDir)
    if (!log.ok) throw new Error('unreachable')
    expect(log.entries).toHaveLength(1)
    expect(labelEntry(log.entries[0]).commentBytes).toBe(Buffer.byteLength('secret content', 'utf8'))
    expect(JSON.stringify(log.entries[0])).not.toContain('secret content')
  })

  it('deletes the scratch file even when gh fails', async () => {
    const { repoRoot } = await makeDirs()
    const scratchDir = await mkdtemp(join(tmpdir(), 'port-writes-comment-'))
    const auditDir = await mkdtemp(join(tmpdir(), 'port-writes-apply-audit-'))
    const gh: GhRunner = () => Promise.resolve({ ok: false, kind: 'unknown', stdout: '', stderr: 'boom' } satisfies GhResult)

    const outcome = await postComment({ request: commentRequest({ scratchDir }), repoRoot, auditDir, gh, now })
    expect(outcome.kind).toBe('write-failed')
    if (outcome.kind !== 'write-failed') return
    expect(outcome.stderr).toBe('boom')

    const remaining = await readdir(scratchDir)
    expect(remaining).toEqual([])
  })

  it('refuses with ownership-unreadable and writes no scratch file when the record names the terminal cockpit', async () => {
    const { repoRoot } = await makeDirs()
    await mkdir(join(repoRoot, '.agents'), { recursive: true })
    await writeFile(join(repoRoot, '.agents', 'cockpit.json'), JSON.stringify({ repo: 'o/r', owner: 'terminal', since: '2026-01-01T00:00:00Z' }), 'utf8')
    const scratchDir = await mkdtemp(join(tmpdir(), 'port-writes-comment-'))
    const auditDir = await mkdtemp(join(tmpdir(), 'port-writes-apply-audit-'))
    const gh = neverCalledGh()

    const outcome = await postComment({ request: commentRequest({ scratchDir }), repoRoot, auditDir, gh, now })
    expect(outcome.kind).toBe('ownership-unreadable')

    const remaining = await readdir(scratchDir)
    expect(remaining).toEqual([])
  })
})

describe('postIssueBody', () => {
  it('edits the issue body from a scratch file, deleted afterwards, and audits the byte length only', async () => {
    const { repoRoot } = await makeDirs()
    const scratchDir = await mkdtemp(join(tmpdir(), 'port-writes-body-'))
    const auditDir = await mkdtemp(join(tmpdir(), 'port-writes-body-audit-'))
    let argv: readonly string[] = []
    let bodyFileContent: string | undefined
    const gh: GhRunner = async (args) => {
      argv = args
      const path = args[args.indexOf('--body-file') + 1]
      if (path) bodyFileContent = await readFile(path, 'utf8')
      return { ok: true, stdout: '', stderr: '' } satisfies GhResult
    }

    const outcome = await postIssueBody({ request: commentRequest({ scratchDir, number: 52, body: 'secret plan', action: 'stage-handback-plan-body' }), repoRoot, auditDir, gh, now })
    expect(outcome.kind).toBe('applied')
    expect(argv.slice(0, 6)).toEqual(['issue', 'edit', '52', '--repo', 'o/r', '--body-file'])
    expect(bodyFileContent).toBe('secret plan')
    expect(await readdir(scratchDir)).toEqual([])

    const log = await readAuditLog(auditDir)
    if (!log.ok) throw new Error('unreachable')
    expect(log.entries).toHaveLength(1)
    expect(labelEntry(log.entries[0])).toMatchObject({ action: 'stage-handback-plan-body', commentBytes: Buffer.byteLength('secret plan', 'utf8') })
    expect(JSON.stringify(log.entries[0])).not.toContain('secret plan')
  })

  it('is a write-failed with the gh message when gh fails, and still deletes the scratch file', async () => {
    const { repoRoot } = await makeDirs()
    const scratchDir = await mkdtemp(join(tmpdir(), 'port-writes-body-'))
    const auditDir = await mkdtemp(join(tmpdir(), 'port-writes-body-audit-'))
    const gh: GhRunner = () => Promise.resolve({ ok: false, kind: 'unknown', stdout: '', stderr: 'boom' } satisfies GhResult)

    const outcome = await postIssueBody({ request: commentRequest({ scratchDir }), repoRoot, auditDir, gh, now })
    expect(outcome).toMatchObject({ kind: 'write-failed', stderr: 'boom' })
    expect(await readdir(scratchDir)).toEqual([])
  })

  it('refuses a pull request without calling gh', async () => {
    const { repoRoot } = await makeDirs()
    const scratchDir = await mkdtemp(join(tmpdir(), 'port-writes-body-'))
    const auditDir = await mkdtemp(join(tmpdir(), 'port-writes-body-audit-'))

    const outcome = await postIssueBody({ request: commentRequest({ scratchDir, kind: 'pull-request' }), repoRoot, auditDir, gh: neverCalledGh(), now })
    expect(outcome).toMatchObject({ kind: 'write-failed' })
    expect(await readdir(scratchDir)).toEqual([])
    const log = await readAuditLog(auditDir)
    if (!log.ok) throw new Error('unreachable')
    expect(log.entries).toHaveLength(1)
  })

  it('refuses with ownership-unreadable and writes no scratch file when the record names the terminal cockpit', async () => {
    const { repoRoot } = await makeDirs()
    await mkdir(join(repoRoot, '.agents'), { recursive: true })
    await writeFile(join(repoRoot, '.agents', 'cockpit.json'), JSON.stringify({ repo: 'o/r', owner: 'terminal', since: '2026-01-01T00:00:00Z' }), 'utf8')
    const scratchDir = await mkdtemp(join(tmpdir(), 'port-writes-body-'))
    const auditDir = await mkdtemp(join(tmpdir(), 'port-writes-body-audit-'))

    const outcome = await postIssueBody({ request: commentRequest({ scratchDir }), repoRoot, auditDir, gh: neverCalledGh(), now })
    expect(outcome.kind).toBe('ownership-unreadable')
    expect(await readdir(scratchDir)).toEqual([])
  })
})
