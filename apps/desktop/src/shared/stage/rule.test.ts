import { describe, expect, it } from 'vitest'
import { proposedRule, validateRule } from './rule'

describe('proposedRule', () => {
  it('narrows a plain-word second token to two tokens', () => {
    expect(proposedRule('Bash', { command: 'git status' })).toBe('Bash(git status *)')
  })

  it('narrows a filter-shaped second token to two tokens', () => {
    expect(proposedRule('Bash', { command: 'pnpm --filter x test' })).toBe('Bash(pnpm *)')
  })

  it('narrows a script path second token to one token', () => {
    expect(proposedRule('Bash', { command: './scripts/x.sh' })).toBe('Bash(./scripts/x.sh *)')
  })

  it('narrows a flag-shaped second token to one token', () => {
    expect(proposedRule('Bash', { command: 'node -e \'1\'' })).toBe('Bash(node *)')
  })

  it('proposes the bare tool name for a non-Bash tool', () => {
    expect(proposedRule('WebFetch', { url: 'https://example.com' })).toBe('WebFetch')
  })

  it('proposes Bash(*) for an empty command', () => {
    expect(proposedRule('Bash', { command: '' })).toBe('Bash(*)')
  })
})

describe('validateRule', () => {
  it('accepts a well-formed rule, trimmed', () => {
    expect(validateRule('  Bash(git status *)  ')).toEqual({ ok: true, rule: 'Bash(git status *)' })
  })

  it('refuses an empty rule', () => {
    expect(validateRule('')).toEqual({ ok: false, reason: 'empty' })
    expect(validateRule('   ')).toEqual({ ok: false, reason: 'empty' })
  })

  it('refuses the unrestricted forms', () => {
    expect(validateRule('Bash')).toEqual({ ok: false, reason: 'unrestricted' })
    expect(validateRule('Bash(*)')).toEqual({ ok: false, reason: 'unrestricted' })
    expect(validateRule('Bash( *)')).toEqual({ ok: false, reason: 'unrestricted' })
  })

  it('refuses a rule carrying a shell metacharacter', () => {
    expect(validateRule('Bash(git status *; rm -rf /)').ok).toBe(false)
    expect(validateRule('Bash(a && b *)').ok).toBe(false)
    expect(validateRule('Bash(a || b *)').ok).toBe(false)
    expect(validateRule('Bash(a | b *)').ok).toBe(false)
    expect(validateRule('Bash(`echo hi` *)').ok).toBe(false)
    expect(validateRule('Bash($(echo hi) *)').ok).toBe(false)
  })

  it('reports an already-present rule as already-allowed, not as an error', () => {
    expect(validateRule('Bash(git status *)', ['Bash(git status *)'])).toEqual({ ok: false, reason: 'already-allowed' })
  })
})
