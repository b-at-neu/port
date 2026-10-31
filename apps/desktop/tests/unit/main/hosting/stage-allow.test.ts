import { describe, expect, it } from 'vitest'
import { editAllowGlobs, readStageEditAllow } from '@/main/hosting/stage-allow'
import { pathOps } from '@/main/platform/paths'

describe('editAllowGlobs', () => {
  it('reads a bare edit tool as every path', () => {
    expect(editAllowGlobs(['Edit', 'Write'])).toEqual(['**', '**'])
  })

  it('reads the glob out of Tool(glob), stripping a leading ./', () => {
    expect(editAllowGlobs(['Edit(apps/**)', 'Write(./docs/**)', 'MultiEdit(a.ts)', 'NotebookEdit(n/**)'])).toEqual(['apps/**', 'docs/**', 'a.ts', 'n/**'])
  })

  it('drops absolute and home-anchored globs', () => {
    expect(editAllowGlobs(['Edit(/etc/**)', 'Edit(//abs/**)', 'Edit(~/x/**)'])).toEqual([])
  })

  it('ignores non-edit tools, unknown shapes, empty globs, and non-strings', () => {
    expect(editAllowGlobs(['Bash(git *)', 'Read(**)', 'Edit()', 'EditFoo', 42, null])).toEqual([])
  })

  it('returns nothing for a non-array', () => {
    expect(editAllowGlobs(undefined)).toEqual([])
    expect(editAllowGlobs({ allow: ['Edit'] })).toEqual([])
  })
})

describe('readStageEditAllow', () => {
  it('reads permissions.allow from the worktree settings file', async () => {
    const readJsonFile = (path: string) => {
      expect(path).toBe(pathOps.join('/repo', '.claude', 'settings.json'))
      return Promise.resolve({ ok: true, value: { permissions: { allow: ['Edit(apps/**)', 'Bash(git *)'] } } } as never)
    }
    await expect(readStageEditAllow('/repo', { readJsonFile })).resolves.toEqual(['apps/**'])
  })

  it('reads a missing or unparseable file as no rules', async () => {
    const missing = () => Promise.resolve({ ok: false, kind: 'not-found', message: 'x' } as never)
    const unparseable = () => Promise.resolve({ ok: false, kind: 'unparseable', message: 'x' } as never)
    await expect(readStageEditAllow('/repo', { readJsonFile: missing })).resolves.toEqual([])
    await expect(readStageEditAllow('/repo', { readJsonFile: unparseable })).resolves.toEqual([])
  })

  it('reads a settings file without permissions as no rules', async () => {
    const readJsonFile = () => Promise.resolve({ ok: true, value: {} } as never)
    await expect(readStageEditAllow('/repo', { readJsonFile })).resolves.toEqual([])
  })
})
