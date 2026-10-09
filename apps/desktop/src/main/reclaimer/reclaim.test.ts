import { describe, expect, it } from 'vitest'
import { createPathOps } from '../platform/paths'
import type { CommandResult } from '../platform/run'
import type { NodeRunner } from '../platform/node'
import { SCRIPT_FAIL_PREFIX } from './report'
import { runReclaim } from './reclaim'

const posixPathOps = createPathOps('posix', { home: '/home/op' })

function ok(stdout: string): CommandResult {
  return { ok: true, stdout, stderr: '' }
}

function nonzero(stdout: string, stderr: string, code = 1): CommandResult {
  return { ok: false, kind: 'nonzero', code, stdout, stderr }
}

function payload(overrides: Record<string, unknown> = {}, candidateOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    mainRoot: '/repo',
    integrationRef: 'origin/dev',
    candidates: [
      {
        path: '/repo/.claude/worktrees/impl-36',
        branch: '36-feature',
        head: 'deadbeef',
        state: 'done',
        reason: '#36 merged (branch-name)',
        rung: 'branch-name',
        issue: 36,
        locked: false,
        lockReason: null,
        dirtyFiles: 0,
        removed: true,
        branchDeleted: true,
        error: null,
        ...candidateOverrides,
      },
    ],
    orphanDirs: [],
    summary: { registered: 1, removed: 1, kept: 0, byState: { done: 1 } },
    ...overrides,
  })
}

describe('runReclaim', () => {
  it('reports not-configured without spawning anything when commands.worktrees is null', async () => {
    let called = false
    const runNode: NodeRunner = () => {
      called = true
      return Promise.resolve(ok(''))
    }
    const result = await runReclaim({ repoRoot: '/repo', worktreesCommand: null, issue: null, runNode, pathOps: posixPathOps })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('not-configured')
    expect(called).toBe(false)
  })

  it('a full success removes the candidate, appending reclaim --json', async () => {
    let seenArgs: readonly string[] = []
    const runNode: NodeRunner = (args) => {
      seenArgs = args
      return Promise.resolve(ok(payload()))
    }
    const result = await runReclaim({ repoRoot: '/repo', worktreesCommand: 'node plugins/port/bin/worktrees.mjs', issue: null, runNode, pathOps: posixPathOps })
    expect(seenArgs).toEqual(['plugins/port/bin/worktrees.mjs', 'reclaim', '--json'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.removed).toBe(1)
    expect(result.results[0]?.outcome).toBe('removed')
  })

  it('adds --issue N when issue is not null', async () => {
    let seenArgs: readonly string[] = []
    const runNode: NodeRunner = (args) => {
      seenArgs = args
      return Promise.resolve(ok(payload()))
    }
    await runReclaim({ repoRoot: '/repo', worktreesCommand: 'node w.mjs', issue: 36, runNode, pathOps: posixPathOps })
    expect(seenArgs).toEqual(['w.mjs', 'reclaim', '--json', '--issue', '36'])
  })

  it('a nonzero exit whose stdout still parses is a partial success', async () => {
    const runNode: NodeRunner = () =>
      Promise.resolve(
        nonzero(
          payload({}, { removed: false, branchDeleted: null, error: 'a review session is still attached' }),
          `${SCRIPT_FAIL_PREFIX}some candidates could not be removed`,
          2,
        ),
      )
    const result = await runReclaim({ repoRoot: '/repo', worktreesCommand: 'node w.mjs', issue: null, runNode, pathOps: posixPathOps })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.removed).toBe(0)
    expect(result.results[0]?.outcome).toBe('failed')
    expect(result.results[0]?.error).toBe('a review session is still attached')
  })

  it('a FAIL stderr with no parseable stdout becomes script-failed', async () => {
    const runNode: NodeRunner = () => Promise.resolve(nonzero('', `${SCRIPT_FAIL_PREFIX}not a git repository`))
    const result = await runReclaim({ repoRoot: '/repo', worktreesCommand: 'node w.mjs', issue: null, runNode, pathOps: posixPathOps })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('script-failed')
    expect(result.message).toBe(`${SCRIPT_FAIL_PREFIX}not a git repository`)
  })

  it('maps a timeout straight through', async () => {
    const runNode: NodeRunner = () => Promise.resolve({ ok: false, kind: 'timeout', timeoutMs: 60_000, stderr: '' })
    const result = await runReclaim({ repoRoot: '/repo', worktreesCommand: 'node w.mjs', issue: null, runNode, pathOps: posixPathOps })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('timeout')
  })

  it('an unsupported runner is reported without spawning', async () => {
    let called = false
    const runNode: NodeRunner = () => {
      called = true
      return Promise.resolve(ok(''))
    }
    const result = await runReclaim({ repoRoot: '/repo', worktreesCommand: 'pnpm run wt', issue: null, runNode, pathOps: posixPathOps })
    expect(called).toBe(false)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('unsupported-runner')
  })

  it('a malformed --json payload on a clean exit is report-unparseable', async () => {
    const runNode: NodeRunner = () => Promise.resolve(ok('not json'))
    const result = await runReclaim({ repoRoot: '/repo', worktreesCommand: 'node w.mjs', issue: null, runNode, pathOps: posixPathOps })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('report-unparseable')
  })

  it('never passes --unlock, --force-dirty or --offline', async () => {
    let seenArgs: readonly string[] = []
    const runNode: NodeRunner = (args) => {
      seenArgs = args
      return Promise.resolve(ok(payload()))
    }
    await runReclaim({ repoRoot: '/repo', worktreesCommand: 'node w.mjs', issue: 1, runNode, pathOps: posixPathOps })
    expect(seenArgs).not.toContain('--unlock')
    expect(seenArgs).not.toContain('--force-dirty')
    expect(seenArgs).not.toContain('--offline')
  })
})
