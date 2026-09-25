import { describe, expect, it } from 'vitest'
import { readClaudeVersion } from './version'

describe('readClaudeVersion', () => {
  it('parses a plain version string', async () => {
    const result = await readClaudeVersion({
      runClaude: () => Promise.resolve({ ok: true, stdout: '2.1.0\n', stderr: '' }),
      minimum: '2.0.0',
    })
    expect(result).toEqual({ ok: true, raw: '2.1.0', belowMinimum: false })
  })

  it('parses version text with a trailing label, e.g. "2.1.0 (Claude Code)"', async () => {
    const result = await readClaudeVersion({
      runClaude: () => Promise.resolve({ ok: true, stdout: '2.1.0 (Claude Code)\n', stderr: '' }),
      minimum: '2.0.0',
    })
    expect(result).toEqual({ ok: true, raw: '2.1.0', belowMinimum: false })
  })

  it('sets belowMinimum without failing, when the installed version is older', async () => {
    const result = await readClaudeVersion({
      runClaude: () => Promise.resolve({ ok: true, stdout: '1.9.9\n', stderr: '' }),
      minimum: '2.0.0',
    })
    expect(result).toEqual({ ok: true, raw: '1.9.9', belowMinimum: true })
  })

  it('a two-digit component compares numerically, never as a string', async () => {
    const result = await readClaudeVersion({
      runClaude: () => Promise.resolve({ ok: true, stdout: '2.10.0\n', stderr: '' }),
      minimum: '2.9.0',
    })
    expect(result).toEqual({ ok: true, raw: '2.10.0', belowMinimum: false })
  })

  it('a spawn failure is ok: false, never a silent pass', async () => {
    const result = await readClaudeVersion({
      runClaude: () => Promise.resolve({ ok: false, kind: 'not-found', command: 'claude', searched: [] }),
    })
    expect(result).toEqual({ ok: false })
  })

  it('unparseable output is ok: false, never a silent pass', async () => {
    const result = await readClaudeVersion({
      runClaude: () => Promise.resolve({ ok: true, stdout: 'garbage, no version here', stderr: '' }),
    })
    expect(result).toEqual({ ok: false })
  })
})
