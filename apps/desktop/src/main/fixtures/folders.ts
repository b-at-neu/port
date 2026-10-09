// Fixture mode's canned `folders:list`/`session:changes` — one port repo, one plain folder, and a
// two-file diff for the streaming session.
import type { FolderEntry, FolderId, SessionChanges } from '../../shared/workspace/types'
import { WIDGETS_ID } from './repos'

export function fixtureFolders(now: Date): readonly FolderEntry[] {
  return [
    {
      id: 'folder-widgets' as FolderId,
      path: '/home/you/src/widgets',
      name: 'widgets',
      git: { root: '/home/you/src/widgets', head: { sha: 'a1b2c3d', branch: 'dev' } },
      repoId: WIDGETS_ID,
      lastUsedAt: now.toISOString(),
    },
    {
      id: 'folder-notes' as FolderId,
      path: '/home/you/notes',
      name: 'notes',
      git: null,
      repoId: null,
      lastUsedAt: null,
    },
  ]
}

export function fixtureSessionChanges(now: Date): SessionChanges {
  return {
    ok: true,
    base: { sha: 'a1b2c3d', label: 'dev' },
    files: [
      {
        path: 'src/widgets/report.ts',
        isNewFile: false,
        additions: 2,
        deletions: 1,
        hunks: [{ oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, lines: [{ sign: 'context', text: ' function buildReport() {' }, { sign: 'del', text: '-  return legacy()' }, { sign: 'add', text: '+  return current()' }, { sign: 'add', text: '+  // cache the result' }] }],
      },
      {
        path: 'src/widgets/report.test.ts',
        isNewFile: true,
        additions: 6,
        deletions: 0,
        hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 6, lines: Array.from({ length: 6 }, (_v, i) => ({ sign: 'add' as const, text: `+line ${String(i + 1)}` })) }],
      },
    ],
    untracked: ['src/widgets/scratch.ts'],
    binary: [],
    summary: [
      { path: 'src/widgets/report.ts', additions: 2, deletions: 1 },
      { path: 'src/widgets/report.test.ts', additions: 6, deletions: 0 },
    ],
    truncated: false,
    readAt: now.toISOString(),
  }
}
