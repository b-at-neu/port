import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'
import type { CommandResult, FileResult, GhResult, GhRunner, GitHubHttpResult, GitHubRequest, GitHubTransport, GitRunner } from '@/types/platform'
import type { ReadyEntry } from '@/types/actions'
import { createBudgetGate } from '@/main/dispatch/budget-gate'
import { renderLedger } from '@/main/dispatch/budget-ledger'
import type { LedgerRow } from '@/types/budget'

const NOW = new Date('2026-09-05T14:02:00.000Z')
const LOG_PATH = '/repo/.temp/budget-session-desktop.tsv'
const CANDIDATE = { kind: 'issue' as const, number: 52, agent: 'impl' as const }
const OPEN_ROW = '52\timpl\tsonnet\t2026-09-05T14:00:00.000Z\topen\t0\t\t52\n'
const LEDGER_ROW: LedgerRow = { stage: 'plan', model: 'opus', startedAt: '2026-09-05T13:00:00.000Z', seconds: 600, outcome: 'completed' }

function entry(): ReadyEntry {
  return {
    id: 'repo-1' as unknown as RepoId,
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
      vocabulary: resolveVocabulary({}),
      commands: { worktrees: null, budget: 'node scripts/budget.mjs' },
      concurrency: { sharedFiles: [], overlapThreshold: 2 },
      sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
      checkDispositions: {},
      overrides: [],
    },
    diagnostics: [],
  }
}

const ok = (stdout: string): GhResult => ({ ok: true, stdout, stderr: '' })
const okHttp = (body: string): GitHubHttpResult => ({ ok: true, status: 200, headers: {}, body })
const unreachable: GitHubHttpResult = { ok: false, kind: 'network', status: null, body: '', message: 'no route' }

function ledgerEnvelope(rows: readonly LedgerRow[], login = 'me'): GitHubHttpResult {
  const nodes = rows.length === 0 ? [] : [{ databaseId: 9, body: renderLedger(rows, null), author: { login } }]
  return okHttp(JSON.stringify({ data: { viewer: { login: 'me' }, repository: { issue: { comments: { nodes } } } } }))
}

interface Harness {
  readonly gate: ReturnType<typeof createBudgetGate>
  readonly ghCalls: (readonly string[])[]
  readonly githubCalls: GitHubRequest[]
  readonly files: Map<string, string>
}

interface HarnessOptions {
  readonly config?: string | null
  readonly files?: Record<string, string>
  /** Answers every GitHub read: the ledger query and a pull request's body. */
  readonly github?: (request: GitHubRequest) => GitHubHttpResult
  /** Answers every `gh` write. */
  readonly gh?: (args: readonly string[]) => GhResult
  readonly failWrites?: boolean
  readonly failReads?: boolean
  readonly throwOnGithub?: boolean
}

function harness(options: HarnessOptions = {}): Harness {
  const files = new Map(Object.entries(options.files ?? {}))
  const ghCalls: (readonly string[])[] = []
  const config = options.config === undefined ? JSON.stringify({ repo: 'acme/widgets', budget: { wallClockMinutes: 120 } }) : options.config
  const git: GitRunner = (args): Promise<CommandResult> => {
    if (args[0] === 'rev-parse') return Promise.resolve({ ok: true, stdout: 'sha\n', stderr: '' })
    if (args[0] === 'show') {
      if (config === null) return Promise.resolve({ ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'fatal: path does not exist in origin/HEAD' })
      return Promise.resolve({ ok: true, stdout: config, stderr: '' })
    }
    return Promise.resolve({ ok: false, kind: 'spawn-failed', message: `unexpected git ${args.join(' ')}` })
  }
  const gh: GhRunner = (args) => {
    ghCalls.push(args)
    return Promise.resolve((options.gh ?? (() => ok('{}')))(args))
  }
  const githubCalls: GitHubRequest[] = []
  const github: GitHubTransport = (request) => {
    githubCalls.push(request)
    if (options.throwOnGithub === true) throw new Error('github exploded')
    return Promise.resolve((options.github ?? (() => ledgerEnvelope([])))(request))
  }
  const readTextFile = (path: string): Promise<FileResult<string>> => {
    if (options.failReads === true) return Promise.resolve({ ok: false, kind: 'io', message: 'disk on fire' })
    const text = files.get(path)
    return Promise.resolve(text === undefined ? { ok: false, kind: 'not-found', message: 'missing' } : { ok: true, value: text })
  }
  const writeTextFile = (path: string, text: string): Promise<FileResult<void>> => {
    if (options.failWrites === true && path === LOG_PATH) return Promise.resolve({ ok: false, kind: 'io', message: 'read-only' })
    files.set(path, text)
    return Promise.resolve({ ok: true, value: undefined })
  }
  const gate = createBudgetGate({
    gh,
    github,
    git,
    readTextFile,
    writeTextFile,
    removeFile: (path) => {
      files.delete(path)
      return Promise.resolve({ ok: true, value: undefined })
    },
    ensureDirectory: () => Promise.resolve({ ok: true, value: undefined }),
    now: () => NOW,
    scratchDir: '/scratch',
    randomUUID: () => 'uuid',
  })
  return { gate, ghCalls, githubCalls, files }
}

describe('createBudgetGate — ceiling', () => {
  it('is unavailable, with no GitHub call, when wallClockMinutes is malformed', async () => {
    const { gate, ghCalls, githubCalls } = harness({ config: JSON.stringify({ budget: { wallClockMinutes: '5' } }) })
    const result = await gate.check(entry(), CANDIDATE, 'sonnet')
    expect(result).toMatchObject({ ok: false, kind: 'unavailable' })
    if (!result.ok) expect(result.message).toContain('budget.wallClockMinutes is "5"')
    expect(ghCalls).toHaveLength(0)
    expect(githubCalls).toHaveLength(0)
  })

  it('is unavailable when the config cannot be read at the default ref', async () => {
    const { gate } = harness({ config: null })
    expect(await gate.reset(entry())).toMatchObject({ ok: false, kind: 'unavailable' })
  })

  it('is unavailable when the config does not parse', async () => {
    const { gate } = harness({ config: '{nope' })
    expect(await gate.reset(entry())).toMatchObject({ ok: false, kind: 'unavailable' })
  })
})

describe('createBudgetGate — reset', () => {
  it('closes an open row as lost, flushes it, and drops the flushed row from the log', async () => {
    const { gate, ghCalls, files } = harness({ files: { [LOG_PATH]: OPEN_ROW } })
    expect(await gate.reset(entry())).toEqual({ ok: true })
    expect(ghCalls.some((c) => c[1] === 'repos/acme/widgets/issues/52/comments')).toBe(true)
    expect(files.get(LOG_PATH)).toBe('')
  })

  it('keeps a row whose flush failed pending, and reports failed', async () => {
    const { gate, files } = harness({
      files: { [LOG_PATH]: OPEN_ROW },
      gh: () => ({ ok: false, kind: 'unknown', stdout: '', stderr: 'boom' }),
    })
    const result = await gate.reset(entry())
    expect(result).toMatchObject({ ok: false, kind: 'failed' })
    if (!result.ok) expect(result.message).toBe('#52: could not flush its impl dispatch to the ledger — keeping the row for the next sweep')
    expect(files.get(LOG_PATH)).toContain('\tpending\t120\tlost\t52')
  })

  it('fails, rather than reading as empty, when the session log is unreadable', async () => {
    const { gate } = harness({ failReads: true })
    expect(await gate.reset(entry())).toMatchObject({ ok: false, kind: 'failed' })
  })
})

describe('createBudgetGate — sweep', () => {
  it('closes a completed description, flushes it, and returns the clause without the Budget prefix', async () => {
    const { gate, files } = harness({ files: { [LOG_PATH]: OPEN_ROW } })
    const result = await gate.sweep(entry(), { live: [], completed: ['impl #52'] })
    expect(result).toEqual({ line: 'session 1 dispatch · 2m 00s agent wall-clock · #52 at 2m 00s of its 120m ceiling (2%)', problem: null })
    expect(files.get(LOG_PATH)).toContain('\tclosed\t120\tcompleted\t52')
  })

  it('leaves a live row open', async () => {
    const { gate, ghCalls, githubCalls } = harness({ files: { [LOG_PATH]: OPEN_ROW } })
    const result = await gate.sweep(entry(), { live: ['impl #52'], completed: [] })
    expect(result).toEqual({ line: 'session 1 dispatch · 2m 00s agent wall-clock', problem: null })
    expect(ghCalls).toHaveLength(0)
    expect(githubCalls).toHaveLength(0)
  })

  it('has no line for an empty log', async () => {
    const { gate } = harness()
    expect(await gate.sweep(entry(), { live: [], completed: [] })).toEqual({ line: null, problem: null })
  })

  it('reports a problem and no line when the ceiling is unreadable', async () => {
    const { gate } = harness({ config: null })
    const result = await gate.sweep(entry(), { live: [], completed: [] })
    expect(result.line).toBeNull()
    expect(result.problem).toContain("the budget ceiling can't be read")
  })
})

describe('createBudgetGate — check', () => {
  it('holds when the ledger is unreadable', async () => {
    const { gate, files } = harness({ github: () => unreachable })
    const result = await gate.check(entry(), CANDIDATE, 'sonnet')
    expect(result).toMatchObject({ ok: true, verdict: 'hold' })
    if (result.ok) expect(result.line).toContain("Couldn't read #52's cost ledger (no route)")
    expect(files.has(LOG_PATH)).toBe(false)
  })

  it('is exceeded at the ceiling and writes no row', async () => {
    const { gate, files } = harness({ config: JSON.stringify({ budget: { wallClockMinutes: 10 } }), github: () => ledgerEnvelope([LEDGER_ROW]) })
    const result = await gate.check(entry(), CANDIDATE, 'sonnet')
    expect(result).toEqual({ ok: true, verdict: 'exceeded', line: '⛔ #52 has consumed 10m 00s of agent wall-clock against a 10m ceiling — escalate instead of dispatching impl #52.' })
    expect(files.has(LOG_PATH)).toBe(false)
  })

  it('allows and appends one open row', async () => {
    const { gate, files } = harness({ github: () => ledgerEnvelope([LEDGER_ROW]) })
    const result = await gate.check(entry(), CANDIDATE, 'sonnet')
    expect(result).toEqual({ ok: true, verdict: 'allow', line: '✅ #52 dispatch allowed — 10m 00s of its 120m ceiling used.' })
    expect(files.get(LOG_PATH)).toBe('52\timpl\tsonnet\t2026-09-05T14:02:00.000Z\topen\t0\t\t52\n')
  })

  it('resolves a pull request to its issue and keeps the PR number as the dispatch number', async () => {
    const { gate, files } = harness({ github: (request) => (request.method === 'GET' ? okHttp(JSON.stringify({ body: 'Closes #52' })) : ledgerEnvelope([])) })
    const result = await gate.check(entry(), { kind: 'pull-request', number: 213, agent: 'review' }, 'opus')
    expect(result).toMatchObject({ ok: true, verdict: 'allow' })
    expect(files.get(LOG_PATH)).toBe('52\treview\topus\t2026-09-05T14:02:00.000Z\topen\t0\t\t213\n')
  })

  it('fails when a pull request body names no ticket', async () => {
    const { gate } = harness({ github: () => okHttp(JSON.stringify({ body: 'nothing' })) })
    expect(await gate.check(entry(), { kind: 'pull-request', number: 213, agent: 'review' }, 'opus')).toMatchObject({ ok: false, kind: 'failed' })
  })

  it('fails, so nothing dispatches unmetered, when the session log cannot be written', async () => {
    const { gate } = harness({ failWrites: true })
    expect(await gate.check(entry(), CANDIDATE, 'sonnet')).toMatchObject({ ok: false, kind: 'failed' })
  })

  it('turns a throwing dependency into a failure, not a rejection', async () => {
    const { gate } = harness({ throwOnGithub: true })
    expect(await gate.check(entry(), CANDIDATE, 'sonnet')).toEqual({ ok: false, kind: 'failed', message: 'github exploded' })
  })
})

describe('createBudgetGate — report', () => {
  it('returns the rendered ledger and its verdict', async () => {
    const { gate } = harness({ github: () => ledgerEnvelope([LEDGER_ROW]) })
    expect(await gate.report(entry(), 52)).toEqual({ ok: true, markdown: renderLedger([LEDGER_ROW], 7200), verdict: 'allow' })
  })

  it('fails, rather than holding, when the ledger is unreadable', async () => {
    const { gate } = harness({ github: () => unreachable })
    expect(await gate.report(entry(), 52)).toMatchObject({ ok: false, kind: 'failed' })
  })
})
