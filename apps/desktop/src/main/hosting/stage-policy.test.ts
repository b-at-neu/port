import { describe, expect, it } from 'vitest'
import { createPathOps } from '../platform/paths'
import { globToRegExp, stagePolicy } from './stage-policy'
import type { StagePolicyParams } from './stage-policy'

const posixOps = createPathOps('posix', { home: '/home/op' })

function policy(sessionRequiredPaths: readonly string[] = ['CLAUDE.md', '.claude/**'], pathOps: StagePolicyParams['pathOps'] = posixOps) {
  return stagePolicy({ cwd: '/repo', sessionRequiredPaths, pathOps })
}

describe('stagePolicy', () => {
  it('asks, never denies, for AskUserQuestion and ExitPlanMode', () => {
    expect(policy()('AskUserQuestion', {})).toEqual({ kind: 'ask', protectedPath: null })
    expect(policy()('ExitPlanMode', {})).toEqual({ kind: 'ask', protectedPath: null })
  })

  it('pauses an edit matching a sessionRequiredPaths glob, naming the repo-relative path', () => {
    expect(policy()('Write', { file_path: '/repo/.claude/settings.json' })).toEqual({ kind: 'ask', protectedPath: '.claude/settings.json' })
    expect(policy()('Edit', { file_path: '/repo/CLAUDE.md' })).toEqual({ kind: 'ask', protectedPath: 'CLAUDE.md' })
  })

  it('reads notebook_path for NotebookEdit, not file_path', () => {
    expect(policy(['notebooks/**'])('NotebookEdit', { notebook_path: '/repo/notebooks/a.ipynb' })).toEqual({ kind: 'ask', protectedPath: 'notebooks/a.ipynb' })
  })

  it('denies an edit outside sessionRequiredPaths', () => {
    const result = policy()('Write', { file_path: '/repo/src/index.ts' })
    expect(result.kind).toBe('deny')
  })

  it('denies an edit outside the worktree rather than pausing it, even if it would otherwise match', () => {
    const result = policy(['**'])('Write', { file_path: '/elsewhere/file.ts' })
    expect(result.kind).toBe('deny')
  })

  it('denies an edit with no string path', () => {
    expect(policy()('Write', {}).kind).toBe('deny')
  })

  it('denies everything else not on the allowlist', () => {
    expect(policy()('Bash', { command: 'rm -rf /' }).kind).toBe('deny')
  })

  it('matches Windows separators the same way, via win32 path ops', () => {
    const winOps = createPathOps('win32', { home: 'C:\\Users\\op' })
    const winPolicy = stagePolicy({ cwd: 'C:\\repo', sessionRequiredPaths: ['.claude/**'], pathOps: winOps })
    expect(winPolicy('Write', { file_path: 'C:\\repo\\.claude\\settings.json' })).toEqual({ kind: 'ask', protectedPath: '.claude/settings.json' })
  })
})

// Glob parity with plugins/port/hooks/lib/guard-rules.mjs's own globToRegExp is pinned in
// scripts/checks/desktop-hosting.ts, which can import a .mjs directly; this file sticks to its own cases.
describe('globToRegExp', () => {
  const CASES: readonly { readonly glob: string; readonly path: string; readonly matches: boolean }[] = [
    { glob: 'CLAUDE.md', path: 'CLAUDE.md', matches: true },
    { glob: 'CLAUDE.md', path: 'src/CLAUDE.md', matches: false },
    { glob: '.claude/**', path: '.claude/settings.json', matches: true },
    { glob: '.claude/**', path: '.claude/sub/dir/file.json', matches: true },
    { glob: '.claude/**', path: '.claudexyz', matches: false },
    { glob: 'src/*.ts', path: 'src/index.ts', matches: true },
    { glob: 'src/*.ts', path: 'src/sub/index.ts', matches: false },
    { glob: 'infra/**', path: 'infra', matches: false },
  ]

  it.each(CASES)('$glob against $path -> $matches', ({ glob, path, matches }) => {
    expect(globToRegExp(glob).test(path)).toBe(matches)
  })
})
