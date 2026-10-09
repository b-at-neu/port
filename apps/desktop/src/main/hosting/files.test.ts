import { describe, expect, it, vi } from 'vitest'
import { listSessionFiles, MAX_FILES } from './files'
import type { FileListingDeps } from './files'
import type { DirEntry } from '../platform/files'

function depsWithGit(lines: readonly string[]): FileListingDeps {
  return {
    gitLines: vi.fn().mockResolvedValue({ ok: true, lines }),
    listDirectory: vi.fn(),
  }
}

function depsWithoutGit(tree: Record<string, readonly DirEntry[]>): FileListingDeps {
  return {
    gitLines: vi.fn().mockResolvedValue({ ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'not a git repository' }),
    listDirectory: vi.fn((path: string) => Promise.resolve(tree[path] !== undefined ? { ok: true, value: tree[path] } : { ok: false, kind: 'not-found', message: 'nope' })),
  } as unknown as FileListingDeps
}

describe('listSessionFiles', () => {
  it('lists git-tracked and untracked files via git ls-files', async () => {
    const deps = depsWithGit(['src/a.ts', 'src/b.ts'])
    const result = await listSessionFiles('/repo', deps)
    expect(result).toEqual({ ok: true, files: ['src/a.ts', 'src/b.ts'], truncated: false })
  })

  it('truncates a git listing over MAX_FILES', async () => {
    const lines = Array.from({ length: MAX_FILES + 5 }, (_, i) => `file-${i}.ts`)
    const deps = depsWithGit(lines)
    const result = await listSessionFiles('/repo', deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.files).toHaveLength(MAX_FILES)
    expect(result.truncated).toBe(true)
  })

  it('falls back to a bounded directory walk when cwd is not a git work tree, skipping dot-directories and node_modules', async () => {
    const deps = depsWithoutGit({
      '/repo': [
        { name: 'a.ts', kind: 'file' },
        { name: '.git', kind: 'directory' },
        { name: 'node_modules', kind: 'directory' },
        { name: 'src', kind: 'directory' },
      ],
      '/repo/src': [{ name: 'b.ts', kind: 'file' }],
    })
    const result = await listSessionFiles('/repo', deps)
    expect(result).toEqual({ ok: true, files: ['a.ts', 'src/b.ts'], truncated: false })
  })

  it('reports unreadable rather than an empty list when the walk fails', async () => {
    const deps: FileListingDeps = {
      gitLines: vi.fn().mockResolvedValue({ ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'not a git repository' }),
      listDirectory: vi.fn().mockResolvedValue({ ok: false, kind: 'permission-denied', message: 'denied' }),
    }
    const result = await listSessionFiles('/repo', deps)
    expect(result).toEqual({ ok: false, message: 'denied' })
  })
})
