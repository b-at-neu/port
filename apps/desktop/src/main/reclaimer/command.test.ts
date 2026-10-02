import { describe, expect, it } from 'vitest'
import { parseNodeCommand } from './command'

describe('parseNodeCommand', () => {
  it('accepts a plain node prefix', () => {
    expect(parseNodeCommand('node plugins/port/bin/worktrees.mjs')).toEqual({
      ok: true,
      binary: 'node',
      args: ['plugins/port/bin/worktrees.mjs'],
    })
  })

  it('accepts a quoted path containing a space', () => {
    expect(parseNodeCommand('node "scripts/port worktrees.mjs"')).toEqual({
      ok: true,
      binary: 'node',
      args: ['scripts/port worktrees.mjs'],
    })
  })

  it('a prefix that is only "node" resolves with no args', () => {
    expect(parseNodeCommand('node')).toEqual({ ok: true, binary: 'node', args: [] })
  })

  it('rejects an unbalanced quote', () => {
    expect(parseNodeCommand('node "a b.mjs')).toEqual({ ok: false, kind: 'unparseable-command' })
  })

  for (const meta of ['|', '&', ';', '<', '>', '$', '`', '(', ')']) {
    it(`rejects the metacharacter '${meta}'`, () => {
      expect(parseNodeCommand(`node "a b.mjs" ${meta} rm -rf /`)).toEqual({ ok: false, kind: 'unparseable-command' })
    })
  }

  it('reports unsupported-runner with the offending token for a pnpm-prefixed command', () => {
    expect(parseNodeCommand('pnpm run wt')).toEqual({ ok: false, kind: 'unsupported-runner', token: 'pnpm' })
  })

  it('reports unparseable-command for an empty string', () => {
    expect(parseNodeCommand('')).toEqual({ ok: false, kind: 'unparseable-command' })
  })

  it('reports unparseable-command for a string that is only whitespace', () => {
    expect(parseNodeCommand('   ')).toEqual({ ok: false, kind: 'unparseable-command' })
  })
})
