import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CommandResult } from '../platform/run'
import { classifyOwnership, readOwnership, releaseOwnership, takeOwnership } from './ownership'
import type { GitRunner } from './ownership'

const NOT_A_REPO: CommandResult = { ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'fatal: not a git repository' }
const now = () => new Date('2026-01-01T00:00:00.000Z')

async function makeRepo(): Promise<{ readonly root: string; readonly git: GitRunner }> {
  const root = await mkdtemp(join(tmpdir(), 'port-ownership-'))
  const git: GitRunner = () => Promise.resolve(NOT_A_REPO) // degrades to repoRoot itself
  return { root, git }
}

describe('classifyOwnership', () => {
  it('is absent when the file does not exist', () => {
    expect(classifyOwnership(false, null, 'o/r')).toEqual({ kind: 'absent' })
  })

  it('is absent for a repo mismatch, never unreadable', () => {
    const text = JSON.stringify({ repo: 'someone/else', owner: 'app', since: '2026-01-01T00:00:00Z' })
    expect(classifyOwnership(true, text, 'o/r')).toEqual({ kind: 'absent' })
  })

  it('is unreadable for malformed JSON', () => {
    const result = classifyOwnership(true, '{not json', 'o/r')
    expect(result.kind).toBe('unreadable')
  })

  it('is unreadable for a JSON value that is not an object', () => {
    expect(classifyOwnership(true, '"just a string"', 'o/r').kind).toBe('unreadable')
  })

  it('is unreadable when since is missing', () => {
    const text = JSON.stringify({ repo: 'o/r', owner: 'app' })
    expect(classifyOwnership(true, text, 'o/r').kind).toBe('unreadable')
  })

  it('is unreadable for an unknown owner', () => {
    const text = JSON.stringify({ repo: 'o/r', owner: 'someone-else', since: '2026-01-01T00:00:00Z' })
    expect(classifyOwnership(true, text, 'o/r').kind).toBe('unreadable')
  })

  it('is app when owner is app', () => {
    const text = JSON.stringify({ repo: 'o/r', owner: 'app', since: '2026-01-01T00:00:00Z' })
    expect(classifyOwnership(true, text, 'o/r')).toEqual({ kind: 'app', since: '2026-01-01T00:00:00Z' })
  })

  it('is terminal when owner is terminal', () => {
    const text = JSON.stringify({ repo: 'o/r', owner: 'terminal', since: '2026-01-01T00:00:00Z' })
    expect(classifyOwnership(true, text, 'o/r')).toEqual({ kind: 'terminal', since: '2026-01-01T00:00:00Z' })
  })

  // The guard hook's own classifier mirrors this one field for field; a plain .mjs file with
  // no imports of its own, so a dynamic import of it resolves fine here.
  it('agrees with the guard hook\'s own classifier on a shared fixture set', async () => {
    // @ts-expect-error — plain .mjs with no declaration file, never part of this program's own module graph
    const hookModule = (await import('../../../../../plugins/port/hooks/lib/ownership-rules.mjs')) as {
      readonly classifyOwnership: (exists: boolean, text: string | null, repo: string) => unknown
    }
    const hookClassify = hookModule.classifyOwnership
    const fixtures: ReadonlyArray<{ readonly exists: boolean; readonly text: string | null; readonly repo: string }> = [
      { exists: false, text: null, repo: 'o/r' },
      { exists: true, text: JSON.stringify({ repo: 'o/r', owner: 'app', since: '2026-01-01T00:00:00Z' }), repo: 'o/r' },
      { exists: true, text: JSON.stringify({ repo: 'o/r', owner: 'terminal', since: '2026-01-01T00:00:00Z' }), repo: 'o/r' },
      { exists: true, text: JSON.stringify({ repo: 'someone/else', owner: 'app', since: '2026-01-01T00:00:00Z' }), repo: 'o/r' },
      { exists: true, text: '{not json', repo: 'o/r' },
      { exists: true, text: '"just a string"', repo: 'o/r' },
      { exists: true, text: JSON.stringify({ repo: 'o/r', owner: 'app' }), repo: 'o/r' },
      { exists: true, text: JSON.stringify({ repo: 'o/r', owner: 'someone-else', since: '2026-01-01T00:00:00Z' }), repo: 'o/r' },
    ]
    for (const f of fixtures) {
      expect(hookClassify(f.exists, f.text, f.repo)).toEqual(classifyOwnership(f.exists, f.text, f.repo))
    }
  })
})

describe('readOwnership', () => {
  it('reports absent for a missing record', async () => {
    const { root, git } = await makeRepo()
    const result = await readOwnership({ repoRoot: root, repo: 'o/r', git, now })
    expect(result).toEqual({ kind: 'absent', path: join(root, '.agents', 'cockpit.json'), readAt: now().toISOString() })
  })

  it('reports app for a matching, well-formed record', async () => {
    const { root, git } = await makeRepo()
    await mkdir(join(root, '.agents'), { recursive: true })
    await writeFile(join(root, '.agents', 'cockpit.json'), JSON.stringify({ repo: 'o/r', owner: 'app', since: '2026-01-01T00:00:00Z' }), 'utf8')
    const result = await readOwnership({ repoRoot: root, repo: 'o/r', git, now })
    expect(result).toEqual({ kind: 'app', since: '2026-01-01T00:00:00Z', path: join(root, '.agents', 'cockpit.json'), readAt: now().toISOString() })
  })

  it('reports terminal for a matching record owned by the terminal cockpit', async () => {
    const { root, git } = await makeRepo()
    await mkdir(join(root, '.agents'), { recursive: true })
    await writeFile(join(root, '.agents', 'cockpit.json'), JSON.stringify({ repo: 'o/r', owner: 'terminal', since: '2026-01-01T00:00:00Z' }), 'utf8')
    const result = await readOwnership({ repoRoot: root, repo: 'o/r', git, now })
    expect(result.kind).toBe('terminal')
  })
})

describe('takeOwnership / releaseOwnership', () => {
  it('take writes owner app then reads back as app', async () => {
    const { root, git } = await makeRepo()
    const taken = await takeOwnership({ repoRoot: root, repo: 'o/r', git, now })
    expect(taken.ok).toBe(true)

    const read = await readOwnership({ repoRoot: root, repo: 'o/r', git, now })
    expect(read).toEqual({ kind: 'app', since: now().toISOString(), path: join(root, '.agents', 'cockpit.json'), readAt: now().toISOString() })
  })

  it('the record round-trips exactly the documented shape', async () => {
    const { root, git } = await makeRepo()
    await takeOwnership({ repoRoot: root, repo: 'o/r', git, now })
    const text = await readFile(join(root, '.agents', 'cockpit.json'), 'utf8')
    expect(JSON.parse(text)).toEqual({ repo: 'o/r', owner: 'app', since: now().toISOString() })
  })

  it('refuses a terminal record without force', async () => {
    const { root, git } = await makeRepo()
    await mkdir(join(root, '.agents'), { recursive: true })
    await writeFile(join(root, '.agents', 'cockpit.json'), JSON.stringify({ repo: 'o/r', owner: 'terminal', since: '2026-01-01T00:00:00Z' }), 'utf8')

    const result = await takeOwnership({ repoRoot: root, repo: 'o/r', git, now })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('refused')

    const read = await readOwnership({ repoRoot: root, repo: 'o/r', git, now })
    expect(read.kind).toBe('terminal')
  })

  it('refuses an unreadable record without force', async () => {
    const { root, git } = await makeRepo()
    await mkdir(join(root, '.agents'), { recursive: true })
    await writeFile(join(root, '.agents', 'cockpit.json'), '{not json', 'utf8')

    const result = await takeOwnership({ repoRoot: root, repo: 'o/r', git, now })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('refused')
  })

  it('force overwrites a terminal record', async () => {
    const { root, git } = await makeRepo()
    await mkdir(join(root, '.agents'), { recursive: true })
    await writeFile(join(root, '.agents', 'cockpit.json'), JSON.stringify({ repo: 'o/r', owner: 'terminal', since: '2026-01-01T00:00:00Z' }), 'utf8')

    const result = await takeOwnership({ repoRoot: root, repo: 'o/r', force: true, git, now })
    expect(result.ok).toBe(true)

    const read = await readOwnership({ repoRoot: root, repo: 'o/r', git, now })
    expect(read).toEqual({ kind: 'app', since: now().toISOString(), path: join(root, '.agents', 'cockpit.json'), readAt: now().toISOString() })
  })

  it('release deletes an app record, and a second release is still ok', async () => {
    const { root, git } = await makeRepo()
    await takeOwnership({ repoRoot: root, repo: 'o/r', git, now })
    const released = await releaseOwnership({ repoRoot: root, repo: 'o/r', git })
    expect(released.ok).toBe(true)

    const read = await readOwnership({ repoRoot: root, repo: 'o/r', git, now })
    expect(read.kind).toBe('absent')

    const releasedAgain = await releaseOwnership({ repoRoot: root, repo: 'o/r', git })
    expect(releasedAgain.ok).toBe(true)
  })

  it('release never deletes a terminal record', async () => {
    const { root, git } = await makeRepo()
    await mkdir(join(root, '.agents'), { recursive: true })
    await writeFile(join(root, '.agents', 'cockpit.json'), JSON.stringify({ repo: 'o/r', owner: 'terminal', since: '2026-01-01T00:00:00Z' }), 'utf8')

    const released = await releaseOwnership({ repoRoot: root, repo: 'o/r', git })
    expect(released.ok).toBe(true)

    const read = await readOwnership({ repoRoot: root, repo: 'o/r', git, now })
    expect(read.kind).toBe('terminal')
  })
})
