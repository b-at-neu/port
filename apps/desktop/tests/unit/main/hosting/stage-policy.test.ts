import { describe, expect, it } from 'vitest'
import { createPathOps } from '@/main/platform/paths'
import { stagePolicy } from '@/main/hosting/stage-policy'
import type { StagePolicyParams } from '@/main/hosting/stage-policy'

const posixOps = createPathOps('posix', { home: '/home/op' })

function policy(sessionRequiredPaths: readonly string[] = ['CLAUDE.md', '.claude/**'], pathOps: StagePolicyParams['pathOps'] = posixOps, editAllow: readonly string[] = []) {
  return stagePolicy({ cwd: '/repo', sessionRequiredPaths, editAllow, pathOps })
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
    const winPolicy = stagePolicy({ cwd: 'C:\\repo', sessionRequiredPaths: ['.claude/**'], editAllow: [], pathOps: winOps })
    expect(winPolicy('Write', { file_path: 'C:\\repo\\.claude\\settings.json' })).toEqual({ kind: 'ask', protectedPath: '.claude/settings.json' })
  })

  describe('an in-worktree edit the repository allowlist already covers', () => {
    it('pauses as protected instead of denying', () => {
      expect(policy([], posixOps, ['**'])('Edit', { file_path: '/repo/plugins/port/data/labels.json' })).toEqual({ kind: 'ask', protectedPath: 'plugins/port/data/labels.json' })
    })

    it('still denies an edit the allowlist does not cover', () => {
      expect(policy([], posixOps, ['apps/**'])('Edit', { file_path: '/repo/plugins/port/data/labels.json' }).kind).toBe('deny')
    })

    it('denies an edit outside the worktree even when the allowlist is **', () => {
      expect(policy([], posixOps, ['**'])('Edit', { file_path: '/elsewhere/labels.json' }).kind).toBe('deny')
    })

    it('matches under win32 path ops too', () => {
      const winOps = createPathOps('win32', { home: 'C:\\Users\\op' })
      const winPolicy = stagePolicy({ cwd: 'C:\\repo', sessionRequiredPaths: [], editAllow: ['plugins/**'], pathOps: winOps })
      expect(winPolicy('Write', { file_path: 'C:\\repo\\plugins\\port\\data\\labels.json' })).toEqual({ kind: 'ask', protectedPath: 'plugins/port/data/labels.json' })
      expect(winPolicy('Write', { file_path: 'C:\\repo\\apps\\a.ts' }).kind).toBe('deny')
    })
  })
})
