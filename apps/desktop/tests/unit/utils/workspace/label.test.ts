import { describe, expect, it } from 'vitest'
import { folderLabel, repoDisplayLabel } from '@/utils/workspace/label'
import type { RepositoryEntry } from '@/utils/repos'

describe('folderLabel', () => {
  it('returns the last posix segment', () => {
    expect(folderLabel('/home/you/src/widgets')).toBe('widgets')
  })

  it('returns the last windows segment', () => {
    expect(folderLabel('C:\\Users\\you\\src\\widgets')).toBe('widgets')
  })

  it('ignores a trailing separator', () => {
    expect(folderLabel('/home/you/src/widgets/')).toBe('widgets')
  })

  it('returns a drive root itself', () => {
    expect(folderLabel('C:\\')).toBe('C:')
  })
})

describe('repoDisplayLabel', () => {
  it('uses config.repo for a ready entry', () => {
    const entry = {
      id: 'repo-1',
      path: '/home/you/src/widgets',
      displayName: 'widgets',
      status: 'ready',
      config: { repo: 'you/widgets' },
      diagnostics: [],
    } as unknown as RepositoryEntry
    expect(repoDisplayLabel(entry, '/home/you/src/widgets')).toBe('you/widgets')
  })

  it('uses displayName for a problem entry', () => {
    const entry = {
      id: 'repo-2',
      path: '/home/you/src/broken',
      displayName: 'broken',
      problem: { kind: 'not-a-git-repository' },
      diagnostics: [],
    } as unknown as RepositoryEntry
    expect(repoDisplayLabel(entry, '/home/you/src/broken')).toBe('broken')
  })

  it('falls back to the folder basename when there is no entry', () => {
    expect(repoDisplayLabel(undefined, '/home/you/src/widgets/')).toBe('widgets')
    expect(repoDisplayLabel(undefined, 'C:\\Users\\you\\src\\widgets')).toBe('widgets')
  })
})
