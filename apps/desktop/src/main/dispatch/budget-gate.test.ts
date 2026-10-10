import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import type { LabelVocabulary } from '../../shared/labels/vocabulary'
import type { RepoId } from '../../shared/repos'
import type { CommandResult } from '../platform/run'
import type { ReadyEntry } from '../actions/apply'
import { createBudgetGate } from './budget-gate'
import type { NodeRunner } from './budget-gate'

const REPO_ID = 'repo-1' as unknown as RepoId
const VOCABULARY: LabelVocabulary = resolveVocabulary({})

function entry(budget: string | null): ReadyEntry {
  return {
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
      commands: { worktrees: null, budget },
      concurrency: { sharedFiles: [], overlapThreshold: 2 },
    sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
      checkDispositions: {},
      overrides: [],
    },
    diagnostics: [],
  }
}

function ok(stdout: string, stderr = ''): CommandResult {
  return { ok: true, stdout, stderr }
}

function nonzero(stderr: string, stdout = ''): CommandResult {
  return { ok: false, kind: 'nonzero', code: 1, stdout, stderr }
}

const CANDIDATE = { kind: 'issue' as const, number: 52, agent: 'impl' as const }

describe('createBudgetGate — reset', () => {
  it('passes reset --session desktop and reports ok on success', async () => {
    let seenArgs: readonly string[] | null = null
    const runNode: NodeRunner = (args) => {
      seenArgs = args
      return Promise.resolve(ok(''))
    }
    const gate = createBudgetGate({ runNode })
    const result = await gate.reset(entry('node scripts/budget.mjs'))
    expect(result).toEqual({ ok: true })
    expect(seenArgs).toEqual(['scripts/budget.mjs', 'reset', '--session', 'desktop'])
  })

  it('reports unavailable without spawning anything when commands.budget is null', async () => {
    let called = false
    const runNode: NodeRunner = () => {
      called = true
      return Promise.resolve(ok(''))
    }
    const gate = createBudgetGate({ runNode })
    const result = await gate.reset(entry(null))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('unavailable')
    expect(result.message).toContain("commands.budget can't run")
    expect(called).toBe(false)
  })

  it('reports unavailable for a non-node runner', async () => {
    const gate = createBudgetGate({ runNode: () => Promise.resolve(ok('')) })
    const result = await gate.reset(entry('pnpm run budget'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('unavailable')
    expect(result.message).toContain("starts with 'pnpm'")
  })

  it('reports unavailable when the script is too old to accept --session', async () => {
    const runNode: NodeRunner = () => Promise.resolve(nonzero("FAIL  unrecognized argument '--session'.\n"))
    const gate = createBudgetGate({ runNode })
    const result = await gate.reset(entry('node scripts/budget.mjs'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('unavailable')
    expect(result.message).toContain('older than this app needs')
  })

  it('reports failed for any other non-zero exit, naming the first FAIL line', async () => {
    const runNode: NodeRunner = () => Promise.resolve(nonzero('FAIL  #52: could not flush its impl dispatch to the ledger\n'))
    const gate = createBudgetGate({ runNode })
    const result = await gate.reset(entry('node scripts/budget.mjs'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('failed')
    expect(result.message).toContain('could not flush')
  })

  it('reports failed with a platform description when there is no FAIL line at all', async () => {
    const runNode: NodeRunner = () => Promise.resolve({ ok: false, kind: 'not-found', command: 'node', searched: ['/usr/bin'] })
    const gate = createBudgetGate({ runNode })
    const result = await gate.reset(entry('node scripts/budget.mjs'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('failed')
    expect(result.message).toContain('not found on PATH')
  })
})

describe('createBudgetGate — sweep', () => {
  it('parses the Budget line from stdout on success', async () => {
    const runNode: NodeRunner = () => Promise.resolve(ok('**Budget:** session 1 dispatch · 2m 00s agent wall-clock\n'))
    const gate = createBudgetGate({ runNode })
    const result = await gate.sweep(entry('node scripts/budget.mjs'), { live: ['impl #52'], completed: [] })
    expect(result).toEqual({ line: 'session 1 dispatch · 2m 00s agent wall-clock', problem: null })
  })

  it('still reads the Budget line from stdout even when the run itself failed', async () => {
    const runNode: NodeRunner = () => Promise.resolve(nonzero('FAIL  #52: could not flush its impl dispatch to the ledger\n', '**Budget:** session 1 dispatch · 2m 00s agent wall-clock\n'))
    const gate = createBudgetGate({ runNode })
    const result = await gate.sweep(entry('node scripts/budget.mjs'), { live: [], completed: [] })
    expect(result.line).toBe('session 1 dispatch · 2m 00s agent wall-clock')
    expect(result.problem).toContain('could not flush')
  })

  it('reports a problem with no line when the script cannot run at all', async () => {
    const gate = createBudgetGate({ runNode: () => Promise.resolve(ok('')) })
    const result = await gate.sweep(entry(null), { live: [], completed: [] })
    expect(result.line).toBeNull()
    expect(result.problem).toContain("commands.budget can't run")
  })
})

describe('createBudgetGate — check', () => {
  it('parses an allow verdict and its human line', async () => {
    const runNode: NodeRunner = () => Promise.resolve(ok('allow\n✅ #52 dispatch allowed — 3m 00s of its 120m ceiling used.\n'))
    const gate = createBudgetGate({ runNode })
    const result = await gate.check(entry('node scripts/budget.mjs'), CANDIDATE, 'sonnet')
    expect(result).toEqual({ ok: true, verdict: 'allow', line: '✅ #52 dispatch allowed — 3m 00s of its 120m ceiling used.' })
  })

  it('passes --issue for an issue candidate and --pr for a pull-request one', async () => {
    let seenArgs: readonly string[] | null = null
    const runNode: NodeRunner = (args) => {
      seenArgs = args
      return Promise.resolve(ok('allow\nok\n'))
    }
    const gate = createBudgetGate({ runNode })
    await gate.check(entry('node scripts/budget.mjs'), { kind: 'pull-request', number: 213, agent: 'review' }, 'opus')
    expect(seenArgs).toEqual(['scripts/budget.mjs', 'dispatch', '--pr', '213', '--stage', 'review', '--model', 'opus', '--session', 'desktop'])
  })

  it('reports failed when the first line is not a recognized verdict', async () => {
    const runNode: NodeRunner = () => Promise.resolve(ok('bogus\nsomething\n'))
    const gate = createBudgetGate({ runNode })
    const result = await gate.check(entry('node scripts/budget.mjs'), CANDIDATE, 'sonnet')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('failed')
  })

  it('reports unavailable when the script is too old to accept --session', async () => {
    const runNode: NodeRunner = () => Promise.resolve(nonzero("FAIL  unrecognized argument '--session'.\n"))
    const gate = createBudgetGate({ runNode })
    const result = await gate.check(entry('node scripts/budget.mjs'), CANDIDATE, 'sonnet')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('unavailable')
  })
})
