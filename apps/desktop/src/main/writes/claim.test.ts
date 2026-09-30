import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CommandResult } from '../platform'
import { readGateClaim, releaseGateClaim, takeGateClaim } from './claim'
import type { GitRunner } from './claim'

const NOT_A_REPO: CommandResult = { ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'fatal: not a git repository' }
const now = () => new Date('2026-01-01T00:00:00.000Z')

async function makeRepo(): Promise<{ readonly root: string; readonly git: GitRunner }> {
  const root = await mkdtemp(join(tmpdir(), 'port-writes-claim-'))
  const git: GitRunner = () => Promise.resolve(NOT_A_REPO) // degrades to repoRoot itself
  return { root, git }
}

describe('readGateClaim', () => {
  it('reports absent for a missing claim file', async () => {
    const { root, git } = await makeRepo()
    const result = await readGateClaim({ repoRoot: root, repo: 'o/r', git, now })
    expect(result).toEqual({ state: 'absent', path: join(root, '.agents', 'gate-claim.json'), readAt: now().toISOString() })
  })

  it('reports held for a matching, well-formed claim', async () => {
    const { root, git } = await makeRepo()
    await mkdir(join(root, '.agents'), { recursive: true })
    await writeFile(
      join(root, '.agents', 'gate-claim.json'),
      JSON.stringify({ repo: 'o/r', owner: 'port-desktop', scopes: ['plan-gate'], claimedAt: '2026-01-01T00:00:00Z' }),
      'utf8',
    )
    const result = await readGateClaim({ repoRoot: root, repo: 'o/r', git, now })
    expect(result).toEqual({
      state: 'held',
      owner: 'port-desktop',
      scopes: ['plan-gate'],
      unknownScopes: [],
      claimedAt: '2026-01-01T00:00:00Z',
      path: join(root, '.agents', 'gate-claim.json'),
      readAt: now().toISOString(),
    })
  })

  it('reports absent, never unreadable, for a repo mismatch', async () => {
    const { root, git } = await makeRepo()
    await mkdir(join(root, '.agents'), { recursive: true })
    await writeFile(
      join(root, '.agents', 'gate-claim.json'),
      JSON.stringify({ repo: 'someone/else', owner: 'x', scopes: ['plan-gate'], claimedAt: '2026-01-01T00:00:00Z' }),
      'utf8',
    )
    const result = await readGateClaim({ repoRoot: root, repo: 'o/r', git, now })
    expect(result.state).toBe('absent')
  })

  it('reports unreadable for malformed JSON', async () => {
    const { root, git } = await makeRepo()
    await mkdir(join(root, '.agents'), { recursive: true })
    await writeFile(join(root, '.agents', 'gate-claim.json'), '{not json', 'utf8')
    const result = await readGateClaim({ repoRoot: root, repo: 'o/r', git, now })
    expect(result.state).toBe('unreadable')
  })

  it('carries an unrecognized scope in unknownScopes rather than dropping it', async () => {
    const { root, git } = await makeRepo()
    await mkdir(join(root, '.agents'), { recursive: true })
    await writeFile(
      join(root, '.agents', 'gate-claim.json'),
      JSON.stringify({ repo: 'o/r', owner: 'x', scopes: ['plan-gate', 'some-future-scope'], claimedAt: '2026-01-01T00:00:00Z' }),
      'utf8',
    )
    const result = await readGateClaim({ repoRoot: root, repo: 'o/r', git, now })
    if (result.state !== 'held') throw new Error('expected held')
    expect(result.scopes).toEqual(['plan-gate'])
    expect(result.unknownScopes).toEqual(['some-future-scope'])
  })
})

describe('takeGateClaim / releaseGateClaim', () => {
  it('take writes a claim readGateClaim then reads back as held', async () => {
    const { root, git } = await makeRepo()
    const taken = await takeGateClaim({ repoRoot: root, repo: 'o/r', owner: 'port-desktop', scopes: ['plan-gate'], git, now })
    expect(taken.ok).toBe(true)

    const read = await readGateClaim({ repoRoot: root, repo: 'o/r', git, now })
    expect(read.state).toBe('held')
    if (read.state !== 'held') return
    expect(read.owner).toBe('port-desktop')
    expect(read.scopes).toEqual(['plan-gate'])
  })

  it('release deletes the file, and a second release is still ok', async () => {
    const { root, git } = await makeRepo()
    await takeGateClaim({ repoRoot: root, repo: 'o/r', owner: 'port-desktop', scopes: ['plan-gate'], git, now })
    const released = await releaseGateClaim({ repoRoot: root, git })
    expect(released.ok).toBe(true)

    const read = await readGateClaim({ repoRoot: root, repo: 'o/r', git, now })
    expect(read.state).toBe('absent')

    const releasedAgain = await releaseGateClaim({ repoRoot: root, git })
    expect(releasedAgain.ok).toBe(true)
  })

  it('the claim file round-trips exactly the documented shape', async () => {
    const { root, git } = await makeRepo()
    await takeGateClaim({ repoRoot: root, repo: 'o/r', owner: 'port-desktop', scopes: ['plan-gate'], git, now })
    const text = await readFile(join(root, '.agents', 'gate-claim.json'), 'utf8')
    expect(JSON.parse(text)).toEqual({ repo: 'o/r', owner: 'port-desktop', scopes: ['plan-gate'], claimedAt: now().toISOString() })
  })
})
