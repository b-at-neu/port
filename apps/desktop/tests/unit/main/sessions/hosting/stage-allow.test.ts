import { describe, expect, it } from 'vitest'
import { editAllowGlobs, readStageEditAllow } from '@/main/sessions/hosting/stage-allow'
import { pathOps } from '@/main/platform/paths'
import { createFakeFs } from '../../../../support/fake-platform'

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
  const settingsPath = pathOps.join('/repo', '.claude', 'settings.json')

  it.each([
    { name: 'reads permissions.allow from the worktree settings file', text: JSON.stringify({ permissions: { allow: ['Edit(apps/**)', 'Bash(git *)'] } }), expected: ['apps/**'] },
    { name: 'reads a missing file as no rules', text: null, expected: [] },
    { name: 'reads an unparseable file as no rules', text: '{', expected: [] },
    { name: 'reads a settings file without permissions as no rules', text: '{}', expected: [] },
  ])('$name', async ({ text, expected }) => {
    const fs = createFakeFs()
    if (text !== null) await fs.writeText(settingsPath, text)
    await expect(readStageEditAllow({ fs }, '/repo')).resolves.toEqual(expected)
  })
})
