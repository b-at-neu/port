import { describe, expect, it } from 'vitest'
import { activeTrigger, applySuggestion, fuzzyRankFiles, rankCommands } from './composer-model'
import type { SlashCommandSummary } from '../../../shared/hosting/types'

describe('activeTrigger', () => {
  it('opens / only at the start of the draft', () => {
    expect(activeTrigger('/sc', 3)).toEqual({ kind: 'command', start: 0, query: 'sc' })
    expect(activeTrigger('hi /sc', 6)).toBeNull()
  })

  it('closes / once a space is typed in the token', () => {
    expect(activeTrigger('/scope add', 10)).toBeNull()
  })

  it('opens @ at the start of the draft', () => {
    expect(activeTrigger('@pl', 3)).toEqual({ kind: 'file', start: 0, query: 'pl' })
  })

  it('opens @ after whitespace, not mid-word', () => {
    expect(activeTrigger('see @pl', 7)).toEqual({ kind: 'file', start: 4, query: 'pl' })
    expect(activeTrigger('email@x', 7)).toBeNull()
  })

  it('closes @ once whitespace follows it', () => {
    expect(activeTrigger('see @pl ugins now', 7)).toEqual({ kind: 'file', start: 4, query: 'pl' })
    expect(activeTrigger('see @pl ugins now', 17)).toBeNull()
  })

  it('is null with no trigger character before the caret', () => {
    expect(activeTrigger('just text', 9)).toBeNull()
  })
})

describe('applySuggestion', () => {
  it('replaces a / token with /name and a trailing space, caret after it', () => {
    const trigger = { kind: 'command' as const, start: 0, query: 'sc' }
    expect(applySuggestion('/sc', trigger, 'scope')).toEqual({ value: '/scope ', caret: 7 })
  })

  it('replaces an @ token in place, keeping surrounding text', () => {
    const trigger = { kind: 'file' as const, start: 4, query: 'pl' }
    expect(applySuggestion('see @pl', trigger, 'plugins/port/SKILL.md')).toEqual({ value: 'see @plugins/port/SKILL.md ', caret: 27 })
  })
})

describe('rankCommands', () => {
  const commands: SlashCommandSummary[] = [
    { name: 'scope', description: 'Decompose a feature', argumentHint: '' },
    { name: 'review', description: 'Scope a review', argumentHint: '' },
    { name: 'other', description: 'Nothing relevant', argumentHint: '' },
    { name: 'escope', description: '', argumentHint: '' },
  ]

  it('ranks a name prefix match first, then a name substring, then a description substring', () => {
    expect(rankCommands(commands, 'scope').map((c) => c.name)).toEqual(['scope', 'escope', 'review'])
  })

  it('drops entries matching neither name nor description', () => {
    expect(rankCommands(commands, 'zzz')).toEqual([])
  })

  it('is case-insensitive', () => {
    expect(rankCommands(commands, 'SCOPE').map((c) => c.name)).toContain('scope')
  })
})

describe('fuzzyRankFiles', () => {
  const files = ['plugins/port/SKILL.md', 'apps/desktop/src/main/index.ts', 'docs/PIPELINE.md', 'package.json']

  it('ranks a basename-anchored subsequence first', () => {
    const result = fuzzyRankFiles(files, 'pl')
    expect(result[0]).toBe('plugins/port/SKILL.md')
  })

  it('matches only a true subsequence, in order', () => {
    const result = fuzzyRankFiles(files, 'pkgjson')
    expect(result).toEqual(['package.json'])
  })

  it('caps results at 50', () => {
    const many = Array.from({ length: 80 }, (_, i) => `file-${i}.ts`)
    expect(fuzzyRankFiles(many, 'file')).toHaveLength(50)
  })

  it('returns the first 50 files unranked when the query is empty', () => {
    expect(fuzzyRankFiles(files, '')).toEqual(files)
  })
})
