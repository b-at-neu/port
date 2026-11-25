import { describe, expect, it } from 'vitest'
import { listSessionFiles, MAX_FILES } from '@/main/sessions/hosting/files'
import type { CommandResult } from '@/types/platform'
import { createFakeFs, fakeGit } from '../../../support/fake-platform'

const NOT_A_REPO: CommandResult = { ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'not a git repository' }

const gitListing = (lines: readonly string[]): CommandResult => ({ ok: true, stdout: `${lines.join('\n')}\n`, stderr: '' })

describe('listSessionFiles', () => {
  const manyFiles = Array.from({ length: MAX_FILES + 5 }, (_, i) => `file-${i}.ts`)

  it.each([
    { name: 'lists git-tracked and untracked files', git: gitListing(['src/a.ts', 'src/b.ts']), files: [] as string[], expected: { ok: true, files: ['src/a.ts', 'src/b.ts'], truncated: false } },
    { name: 'reads an empty git listing as no files', git: { ok: true, stdout: '', stderr: '' } as CommandResult, files: [], expected: { ok: true, files: [], truncated: false } },
    { name: 'truncates a git listing over MAX_FILES', git: gitListing(manyFiles), files: [], expected: { ok: true, files: manyFiles.slice(0, MAX_FILES), truncated: true } },
    {
      name: 'falls back to a walk outside a work tree, skipping dot-directories and node_modules',
      git: NOT_A_REPO,
      files: ['/repo/a.ts', '/repo/.git/HEAD', '/repo/node_modules/x/index.js', '/repo/src/b.ts'],
      expected: { ok: true, files: ['a.ts', 'src/b.ts'], truncated: false },
    },
    { name: 'reports unreadable rather than an empty list when the walk fails', git: NOT_A_REPO, files: [], expected: { ok: false, message: '/repo does not exist' } },
  ])('$name', async ({ git, files, expected }) => {
    const fs = createFakeFs()
    for (const file of files) await fs.writeText(file, '')
    const result = await listSessionFiles({ git: fakeGit(() => Promise.resolve(git)), fs }, '/repo')
    expect(result).toEqual(expected)
  })
})
