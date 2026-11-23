import { describe, expect, it } from 'vitest'
import type { CommandResult } from '@/types/platform'
import { classifyOwnership, readOwnership, releaseOwnership, takeOwnership } from '@/main/repos/ownership'
import { createFakeFs, createFakeClock, fakeGit } from '../../../support/fake-platform'

const SINCE = '2026-01-01T00:00:00Z'
const ROOT = '/repo'
const FILE = `${ROOT}/.agents/cockpit.json`
const NOT_A_REPO: CommandResult = { ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'fatal: not a git repository' }

describe('classifyOwnership', () => {
  it.each([
    { name: 'a missing file', raw: undefined, expected: { kind: 'absent' } },
    { name: 'a repo mismatch, never unreadable', raw: { repo: 'someone/else', owner: 'app', since: SINCE }, expected: { kind: 'absent' } },
    { name: 'a value that is not an object', raw: 'just a string', expected: { kind: 'unreadable', message: 'cockpit.json is not a JSON object' } },
    { name: 'a missing since', raw: { repo: 'o/r', owner: 'app' }, expected: { kind: 'unreadable', message: "cockpit.json is missing 'since'" } },
    { name: 'an unknown owner', raw: { repo: 'o/r', owner: 'someone-else', since: SINCE }, expected: { kind: 'unreadable', message: "cockpit.json has an unknown 'owner'" } },
    { name: 'owner app', raw: { repo: 'o/r', owner: 'app', since: SINCE }, expected: { kind: 'app', since: SINCE } },
  ])('classifies $name', ({ raw, expected }) => {
    expect(classifyOwnership(raw, 'o/r')).toEqual(expected)
  })

  it('names the terminal cockpit when owner is terminal', () => {
    const result = classifyOwnership({ repo: 'o/r', owner: 'terminal', since: SINCE }, 'o/r')
    expect(result.kind === 'unreadable' && result.message).toContain('terminal cockpit')
  })
})

function setup(file?: string) {
  const clock = createFakeClock('2026-01-01T00:00:00.000Z')
  const fs = createFakeFs(clock)
  const ctx = { git: fakeGit(() => Promise.resolve(NOT_A_REPO)), fs, clock }
  const ready = file === undefined ? Promise.resolve() : fs.writeText(FILE, file).then(() => undefined)
  return { ctx, fs, ready, params: { repoRoot: ROOT, repo: 'o/r' } }
}

const record = (owner: string): string => JSON.stringify({ repo: 'o/r', owner, since: SINCE })

describe('readOwnership', () => {
  it.each([
    { name: 'absent for a missing record', file: undefined, expected: { kind: 'absent' } },
    { name: 'app for a matching record', file: record('app'), expected: { kind: 'app', since: SINCE } },
    { name: 'unreadable for a terminal record', file: record('terminal'), expected: { kind: 'unreadable' } },
    { name: 'unreadable for malformed JSON', file: '{not json', expected: { kind: 'unreadable' } },
  ])('reports $name', async ({ file, expected }) => {
    const { ctx, ready, params } = setup(file)
    await ready
    expect(await readOwnership(ctx, params)).toMatchObject({ ...expected, path: FILE, readAt: '2026-01-01T00:00:00.000Z' })
  })
})

describe('takeOwnership', () => {
  it('writes exactly the documented shape, with no version key, then reads back as app', async () => {
    const { ctx, fs, params } = setup()
    expect((await takeOwnership(ctx, params)).ok).toBe(true)

    const text = await fs.readText(FILE)
    expect(text.ok && JSON.parse(text.value)).toEqual({ repo: 'o/r', owner: 'app', since: '2026-01-01T00:00:00.000Z' })
    expect(await readOwnership(ctx, params)).toMatchObject({ kind: 'app', since: '2026-01-01T00:00:00.000Z' })
  })

  it.each([
    { name: 'a terminal record', file: record('terminal') },
    { name: 'an unparseable record', file: '{not json' },
  ])('refuses $name and leaves it unchanged', async ({ file }) => {
    const { ctx, fs, ready, params } = setup(file)
    await ready

    const result = await takeOwnership(ctx, params)
    expect(result.ok === false && result.kind).toBe('refused')
    expect(await fs.readText(FILE)).toEqual({ ok: true, value: file })
  })
})

describe('releaseOwnership', () => {
  it('deletes an app record, and a second release is still ok', async () => {
    const { ctx, fs, ready, params } = setup(record('app'))
    await ready

    expect((await releaseOwnership(ctx, params)).ok).toBe(true)
    expect(await fs.exists(FILE)).toBe(false)
    expect((await releaseOwnership(ctx, params)).ok).toBe(true)
  })

  it('never deletes a terminal record', async () => {
    const { ctx, fs, ready, params } = setup(record('terminal'))
    await ready

    expect((await releaseOwnership(ctx, params)).ok).toBe(true)
    expect(await fs.exists(FILE)).toBe(true)
  })
})
