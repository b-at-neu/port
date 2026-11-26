import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { ApplyLabelsParams, AuditEntry, CommentRequest, LabelAuditEntry, ObservedItem } from '@/types/writes'
import { isLabelAuditEntry } from '@/types/writes'
import type { CommandResult, GhResult, GhRunner } from '@/types/platform'
import { applyLabels, postComment, postIssueBody } from '@/main/github/writes/apply'
import { readAuditLog } from '@/main/github/writes/audit'
import { hostFs } from '@/main/platform'
import { takeOwnership } from '@/main/repos/ownership'
import { createFakePlatform } from '../../../../support/fake-platform'
import { httpOk } from '../../../../fixtures/github-http'

const REPO_ID = 'repo-1' as unknown as RepoId
const NOT_A_REPO: CommandResult = { ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'fatal: not a git repository' }
const now = () => new Date('2026-01-01T00:00:00.000Z')
const GH_OK: GhResult = { ok: true, stdout: '', stderr: '' }
const TERMINAL = JSON.stringify({ repo: 'o/r', owner: 'terminal', since: '2026-01-01T00:00:00Z' })

function ctxWith(ghWrite: GhRunner, githubHttp = createFakePlatform().githubHttp) {
  return { ...createFakePlatform(), ghWrite, git: () => Promise.resolve(NOT_A_REPO), githubHttp, clock: { now } }
}

const neverCalledGh: GhRunner = () => {
  throw new Error('gh should not have been called')
}

async function makeDirs(cockpit?: string): Promise<{ readonly repoRoot: string; readonly auditDir: string; readonly scratchDir: string }> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'port-writes-apply-repo-'))
  const auditDir = await mkdtemp(join(tmpdir(), 'port-writes-apply-audit-'))
  const scratchDir = await mkdtemp(join(tmpdir(), 'port-writes-apply-scratch-'))
  if (cockpit !== undefined) {
    await mkdir(join(repoRoot, '.agents'), { recursive: true })
    await writeFile(join(repoRoot, '.agents', 'cockpit.json'), cockpit, 'utf8')
  }
  return { repoRoot, auditDir, scratchDir }
}

const observedOf = (labels: readonly string[] = []): ObservedItem => ({ labels, assignees: [], readAt: '2026-01-01T00:00:00.000Z' })

function params(dirs: { readonly repoRoot: string; readonly auditDir: string }, overrides: Partial<ApplyLabelsParams> = {}): ApplyLabelsParams {
  const { repoRoot, auditDir } = dirs
  return { repo: 'o/r', repoId: REPO_ID, kind: 'issue', number: 1, action: 'test', addNames: [], removeNames: [], addAssignees: [], removeAssignees: [], observed: observedOf(), repoRoot, auditDir, ...overrides }
}

function labelEntry(entry: AuditEntry | undefined): LabelAuditEntry {
  if (entry === undefined || !isLabelAuditEntry(entry)) throw new Error('unreachable: expected a label audit entry')
  return entry
}

async function onlyEntry(auditDir: string): Promise<LabelAuditEntry> {
  const log = await readAuditLog(auditDir)
  if (!log.ok) throw new Error('unreachable')
  expect(log.entries).toHaveLength(1)
  return labelEntry(log.entries[0])
}

const REREAD = JSON.stringify({ data: { repository: { n0: { __typename: 'Issue', number: 1, title: 't', url: 'u', state: 'OPEN', labels: { nodes: [{ name: 'seen' }] } } } } })

describe('applyLabels', () => {
  const cases: readonly {
    readonly name: string
    readonly cockpit?: string
    readonly gh: GhRunner
    readonly over?: Partial<ApplyLabelsParams>
    readonly outcome: object
    readonly ownership: string
  }[] = [
    { name: 'a terminal-owned repo is unreadable, even for a convergent write', cockpit: TERMINAL, gh: neverCalledGh, over: { addNames: ['ready'], removeNames: ['blocked'] }, outcome: { kind: 'ownership-unreadable' }, ownership: 'unreadable' },
    { name: 'a malformed cockpit.json is unreadable', cockpit: '{not json', gh: neverCalledGh, over: { addNames: ['ready'] }, outcome: { kind: 'ownership-unreadable' }, ownership: 'unreadable' },
    { name: 'a state that already holds is a no-op without a gh call', gh: neverCalledGh, over: { addNames: ['ready'], observed: observedOf(['ready']) }, outcome: { kind: 'no-op' }, ownership: 'absent' },
    {
      name: 'an unowned repo applies the write as given, without comparing labels',
      gh: () => Promise.resolve(GH_OK),
      over: { addNames: ['blocked'], observed: observedOf(['in progress']) },
      outcome: { kind: 'applied' },
      ownership: 'absent',
    },
    {
      name: 'a gh failure is write-failed with stderr verbatim and one re-read',
      gh: () => Promise.resolve({ ok: false, kind: 'unknown', stdout: '', stderr: "gh: label 'ready' not found" }),
      over: { addNames: ['ready'] },
      outcome: { kind: 'write-failed', stderr: "gh: label 'ready' not found", reread: { labels: ['seen'] } },
      ownership: 'absent',
    },
  ]
  it.each(cases)('$name', async ({ cockpit, gh, over, outcome, ownership }) => {
    const dirs = await makeDirs(cockpit)
    const result = await applyLabels(ctxWith(gh, () => Promise.resolve(httpOk(REREAD))), params(dirs, over))
    expect(result).toMatchObject(outcome)
    expect((await onlyEntry(dirs.auditDir)).ownership).toBe(ownership)
  })

  it('writes the exact argv while this app owns the repo', async () => {
    const dirs = await makeDirs()
    await takeOwnership({ git: () => Promise.resolve(NOT_A_REPO), fs: hostFs, clock: { now } }, { repoRoot: dirs.repoRoot, repo: 'o/r' })
    let argv: readonly string[] = []
    const gh: GhRunner = (args) => {
      argv = args
      return Promise.resolve(GH_OK)
    }
    const outcome = await applyLabels(ctxWith(gh), params(dirs, { addNames: ['plan approved'], removeNames: ['plan review'], observed: observedOf(['plan review']) }))
    expect(outcome).toEqual({ kind: 'applied', argv })
    expect(argv).toEqual(['issue', 'edit', '1', '--repo', 'o/r', '--add-label', 'plan approved', '--remove-label', 'plan review'])
    expect((await onlyEntry(dirs.auditDir)).ownership).toBe('app')
  })
})

const commentRequest = (scratchDir: string, overrides: Partial<CommentRequest> = {}): CommentRequest => ({ repoId: REPO_ID, repo: 'o/r', kind: 'issue', number: 1, body: 'hello', action: 'test comment', scratchDir, ...overrides })

describe.each([
  { name: 'postComment', post: postComment, argvHead: ['issue', 'comment', '1', '--repo', 'o/r', '--body-file'] },
  { name: 'postIssueBody', post: postIssueBody, argvHead: ['issue', 'edit', '1', '--repo', 'o/r', '--body-file'] },
])('$name', ({ post, argvHead }) => {
  it('passes the body as --body-file, deletes it afterwards, and audits byte length only', async () => {
    const dirs = await makeDirs()
    let argv: readonly string[] = []
    let content: string | undefined
    const gh: GhRunner = async (args) => {
      argv = args
      content = await readFile(args[args.indexOf('--body-file') + 1] ?? '', 'utf8')
      return GH_OK
    }
    const outcome = await post(ctxWith(gh), { request: commentRequest(dirs.scratchDir, { body: 'secret content' }), repoRoot: dirs.repoRoot, auditDir: dirs.auditDir })
    expect(outcome.kind).toBe('applied')
    expect(argv.slice(0, 6)).toEqual(argvHead)
    expect(content).toBe('secret content')
    expect(await readdir(dirs.scratchDir)).toEqual([])
    const entry = await onlyEntry(dirs.auditDir)
    expect(entry.commentBytes).toBe(Buffer.byteLength('secret content', 'utf8'))
    expect(JSON.stringify(entry)).not.toContain('secret content')
  })

  it('is write-failed with the gh message and still deletes the scratch file', async () => {
    const dirs = await makeDirs()
    const gh: GhRunner = () => Promise.resolve({ ok: false, kind: 'unknown', stdout: '', stderr: 'boom' })
    const outcome = await post(ctxWith(gh), { request: commentRequest(dirs.scratchDir), repoRoot: dirs.repoRoot, auditDir: dirs.auditDir })
    expect(outcome).toMatchObject({ kind: 'write-failed', stderr: 'boom' })
    expect(await readdir(dirs.scratchDir)).toEqual([])
  })

  it('is ownership-unreadable with no scratch file when the record names the terminal cockpit', async () => {
    const dirs = await makeDirs(TERMINAL)
    const outcome = await post(ctxWith(neverCalledGh), { request: commentRequest(dirs.scratchDir), repoRoot: dirs.repoRoot, auditDir: dirs.auditDir })
    expect(outcome.kind).toBe('ownership-unreadable')
    expect(await readdir(dirs.scratchDir)).toEqual([])
  })
})

describe('postIssueBody', () => {
  it('refuses a pull request without calling gh, and audits the refusal', async () => {
    const dirs = await makeDirs()
    const outcome = await postIssueBody(ctxWith(neverCalledGh), { request: commentRequest(dirs.scratchDir, { kind: 'pull-request' }), repoRoot: dirs.repoRoot, auditDir: dirs.auditDir })
    expect(outcome).toMatchObject({ kind: 'write-failed' })
    expect(await readdir(dirs.scratchDir)).toEqual([])
    await onlyEntry(dirs.auditDir)
  })
})
