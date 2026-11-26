import { describe, expect, it } from 'vitest'
import { readClaudeVersion } from '@/main/sessions/runtime/version'
import type { CommandResult } from '@/types/platform'
import { fakeRun } from '../../../../support/fake-platform'

const printed = (stdout: string): CommandResult => ({ ok: true, stdout, stderr: '' })

describe('readClaudeVersion', () => {
  it.each<{ readonly name: string; readonly run: CommandResult; readonly minimum?: string; readonly expected: unknown }>([
    { name: 'parses a plain version string', run: printed('2.1.0\n'), minimum: '2.0.0', expected: { ok: true, raw: '2.1.0', belowMinimum: false } },
    { name: 'parses version text with a trailing label', run: printed('2.1.0 (Claude Code)\n'), minimum: '2.0.0', expected: { ok: true, raw: '2.1.0', belowMinimum: false } },
    { name: 'sets belowMinimum without failing when the installed version is older', run: printed('1.9.9\n'), minimum: '2.0.0', expected: { ok: true, raw: '1.9.9', belowMinimum: true } },
    { name: 'compares a two-digit component numerically, never as a string', run: printed('2.10.0\n'), minimum: '2.9.0', expected: { ok: true, raw: '2.10.0', belowMinimum: false } },
    { name: 'reads a spawn failure as ok: false, never a silent pass', run: { ok: false, kind: 'not-found', command: 'claude', searched: [] }, expected: { ok: false } },
    { name: 'reads unparseable output as ok: false, never a silent pass', run: printed('garbage, no version here'), expected: { ok: false } },
  ])('$name', async ({ run, minimum, expected }) => {
    await expect(readClaudeVersion({ run: fakeRun(() => Promise.resolve(run)) }, minimum)).resolves.toEqual(expected)
  })
})
