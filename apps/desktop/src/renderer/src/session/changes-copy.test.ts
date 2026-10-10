import { describe, expect, it } from 'vitest'
import { binaryLine, changesEmpty, changesErrorCopy, changesHeaderText, changesTooLarge, numstatLine, untrackedLine } from './changes-copy'

describe('changesHeaderText', () => {
  it('names the worktree branch for a worktree session', () => {
    expect(changesHeaderText({ sha: '3eb526c123456' }, 'session/ab12cd')).toBe('Changes since session/ab12cd base · 3eb526c')
  })

  it('omits the branch for a non-worktree session', () => {
    expect(changesHeaderText({ sha: '3eb526c123456' }, null)).toBe('Changes since 3eb526c')
  })
})

describe('changesEmpty', () => {
  it('shortens the sha', () => {
    expect(changesEmpty('3eb526c123456')).toBe('No changes since 3eb526c.')
  })
})

describe('changesTooLarge', () => {
  it('pluralises the file count', () => {
    expect(changesTooLarge(1)).toBe('This diff is too large to show here. 1 file changed.')
    expect(changesTooLarge(42)).toBe('This diff is too large to show here. 42 files changed.')
  })
})

describe('untrackedLine / binaryLine', () => {
  it('names the path', () => {
    expect(untrackedLine('src/new-file.ts')).toBe('New, not yet added: src/new-file.ts')
    expect(binaryLine('assets/logo.png')).toBe('assets/logo.png · binary')
  })
})

describe('numstatLine', () => {
  it('uses the true minus sign for deletions', () => {
    expect(numstatLine({ additions: 12, deletions: 3 })).toEqual({ added: '+12', removed: '−3' })
  })
})

describe('changesErrorCopy', () => {
  it('names the sha when base-missing carries one', () => {
    expect(changesErrorCopy({ kind: 'base-missing', message: '' }, '3eb526c123456')).toBe('The base commit 3eb526c is gone from this repository.')
  })

  it('drops the sha when none is known', () => {
    expect(changesErrorCopy({ kind: 'base-missing', message: '' }, null)).toBe('The base commit is gone from this repository.')
  })

  it('covers folder-missing, git-failed, unknown-session and not-git', () => {
    expect(changesErrorCopy({ kind: 'folder-missing', message: '' }, null)).toBe("This session's folder no longer exists.")
    expect(changesErrorCopy({ kind: 'git-failed', message: 'exit code 128' }, null)).toBe("git couldn't compute the diff: exit code 128")
    expect(changesErrorCopy({ kind: 'unknown-session', message: '' }, null)).toBe('This session is no longer open.')
    expect(changesErrorCopy({ kind: 'not-git', message: '' }, null)).toBe("This session's folder isn't a git repository.")
  })

  it('reports an unreachable query distinctly', () => {
    expect(changesErrorCopy('unreachable', null)).toBe('Could not reach the main process.')
  })
})
