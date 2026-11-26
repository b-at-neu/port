import { describe, expect, it } from 'vitest'
import { resolveStartTarget } from '@/main/repos/worktree/target'
import type { StartTargetSources } from '@/types/workspace'
import { toFolderId } from '@/main/repos/worktree/resolve'
import { pathOps } from '@/main/platform/paths'
import type { CommandResult, GitRunner } from '@/types/platform'
import type { SessionStartMode, SessionStartTarget } from '@/types/hosting'
import { createFakeFs } from '../../../../support/fake-platform'
import { readyEntry } from '../../../../support/repo-config'

const REPO_PATH = '/home/you/src/widgets'
const NOT_A_REPO: CommandResult = { ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'not a repository' }
const ok = (stdout: string): CommandResult => ({ ok: true, stdout, stderr: '' })
const FRESH: SessionStartMode = { kind: 'fresh' }

const session = (cwd: string | null) => ({ sessionId: 's1', summary: null, lastModified: 't', customTitle: null, firstPrompt: null, gitBranch: null, cwd })

async function run(options: { readonly git?: GitRunner; readonly present?: readonly string[]; readonly sessions?: readonly ReturnType<typeof session>[] }, target: SessionStartTarget, mode: SessionStartMode = FRESH) {
  const fs = createFakeFs()
  for (const path of options.present ?? [REPO_PATH]) await fs.ensureDir(path)
  const sources: StartTargetSources = {
    repositories: [readyEntry({ path: REPO_PATH })],
    recents: { load: () => Promise.resolve([]), record: () => Promise.resolve() },
    readSessions: () => Promise.resolve({ ok: true, sessions: options.sessions ?? [] }),
  }
  return resolveStartTarget({ git: options.git ?? (() => Promise.resolve(NOT_A_REPO)), fs }, target, mode, sources)
}

// Reuses the real `toFolderId`/`pathKey` so the test exercises the same platform-normalized lookup `resolveFolderPath` performs.
const folder = (worktree: boolean): SessionStartTarget => ({ kind: 'folder', folderId: toFolderId(pathOps.pathKey(REPO_PATH)), worktree })
const resume = (sessionId: string): SessionStartMode => ({ kind: 'resume', sessionId })

describe('resolveStartTarget', () => {
  it('throws for an unknown folderId', async () => {
    await expect(run({}, { kind: 'folder', folderId: 'folder-bogus', worktree: false })).rejects.toThrow(/no folder registered/)
  })

  it.each([
    { name: 'a registered folder that no longer exists', present: [], target: folder(false), mode: FRESH, sessions: [], expected: { ok: false, kind: 'folder-missing', path: REPO_PATH } },
    { name: 'a worktree request on a non-git folder', target: folder(true), mode: FRESH, sessions: [], expected: { ok: false, kind: 'not-git' } },
    { name: 'an unknown transcript', target: { kind: 'transcript' } as const, mode: resume('unknown-1'), sessions: [], expected: { ok: false, kind: 'folder-missing', path: null } },
    { name: 'a transcript carrying no cwd', target: { kind: 'transcript' } as const, mode: resume('s1'), sessions: [session(null)], expected: { ok: false, kind: 'folder-missing', path: null } },
    { name: 'a transcript whose cwd no longer exists', target: { kind: 'transcript' } as const, mode: resume('s1'), sessions: [session('/gone')], expected: { ok: false, kind: 'folder-missing', path: '/gone' } },
  ])('returns $name as a typed result', async ({ present, target, mode, sessions, expected }) => {
    expect(await run({ present, sessions }, target, mode)).toEqual(expected)
  })

  it('returns worktree-failed when creation fails', async () => {
    const git: GitRunner = (args) => Promise.resolve(args[0] === 'worktree' ? { ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'fatal: broken' } : ok(`${REPO_PATH}\n`))
    expect(await run({ git }, folder(true))).toEqual({ ok: false, kind: 'worktree-failed', message: 'git worktree add failed: fatal: broken' })
  })
})
