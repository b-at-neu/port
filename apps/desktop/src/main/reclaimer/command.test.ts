import { describe, expect, it } from 'vitest'
import { parseWorktreesCommand } from './command'

describe('parseWorktreesCommand', () => {
  it('accepts a plain node prefix', () => {
    expect(parseWorktreesCommand('node plugins/port/templates/worktrees.mjs')).toEqual({
      ok: true,
      binary: 'node',
      args: ['plugins/port/templates/worktrees.mjs'],
    })
  })

  it('accepts a quoted path containing a space', () => {
    expect(parseWorktreesCommand('node "scripts/port worktrees.mjs"')).toEqual({
      ok: true,
      binary: 'node',
      args: ['scripts/port worktrees.mjs'],
    })
  })

  it('a prefix that is only "node" resolves with no args', () => {
    expect(parseWorktreesCommand('node')).toEqual({ ok: true, binary: 'node', args: [] })
  })

  it('rejects an unbalanced quote', () => {
    expect(parseWorktreesCommand('node "a b.mjs')).toEqual({ ok: false, kind: 'unparseable-command' })
  })

  for (const meta of ['|', '&', ';', '<', '>', '$', '`', '(', ')']) {
    it(`rejects the metacharacter '${meta}'`, () => {
      expect(parseWorktreesCommand(`node "a b.mjs" ${meta} rm -rf /`)).toEqual({ ok: false, kind: 'unparseable-command' })
    })
  }

  it('reports unsupported-runner with the offending token for a pnpm-prefixed command', () => {
    expect(parseWorktreesCommand('pnpm run wt')).toEqual({ ok: false, kind: 'unsupported-runner', token: 'pnpm' })
  })

  it('reports unparseable-command for an empty string', () => {
    expect(parseWorktreesCommand('')).toEqual({ ok: false, kind: 'unparseable-command' })
  })

  it('reports unparseable-command for a string that is only whitespace', () => {
    expect(parseWorktreesCommand('   ')).toEqual({ ok: false, kind: 'unparseable-command' })
  })
})
