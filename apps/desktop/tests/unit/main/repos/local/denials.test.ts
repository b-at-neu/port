import { describe, expect, it } from 'vitest'
import type { CommandResult } from '@/types/platform'
import { pathOps } from '@/main/platform/paths'
import { readDenials } from '@/main/repos/local/denials'
import { createFakeClock, createFakeFs, fakeGit } from '../../../../support/fake-platform'

const NOT_A_REPO: CommandResult = { ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'fatal: not a git repository' }
const ROOT = pathOps.toNative('/repo')
const LOG = pathOps.join(ROOT, '.agents', 'denials.log')
const NOW = '2026-01-01T00:00:00.000Z'

/** The git runner fails, so the base root degrades to the repo root itself. */
async function read(logText: string | undefined, options?: { readonly limit?: number }) {
  const clock = createFakeClock(NOW)
  const fs = createFakeFs(clock)
  if (logText !== undefined) await fs.writeText(LOG, logText)
  return readDenials({ git: fakeGit(() => Promise.resolve(NOT_A_REPO)), fs, clock }, ROOT, options)
}

async function readPresent(logText: string, options?: { readonly limit?: number }) {
  const result = await read(logText, options)
  if (!result.ok || !result.present) throw new Error('expected present')
  return result
}

const line = (decision: string, actor: string, subject: string, at = '2026-01-01T00:00:00Z'): string => `${at}\t${decision}\t${actor}\t${subject}\n`

describe('readDenials — present / absent', () => {
  it('reports present: false, not ok: false, for a missing log', async () => {
    expect(await read(undefined)).toEqual({ ok: true, present: false, path: LOG, readAt: NOW })
  })

  it('reports present: true with entries for an existing log', async () => {
    const result = await readPresent(line('deny', 'port:port:impl-agent', 'git push origin main'))
    expect(result.entries).toHaveLength(1)
    expect(result.capped).toBe(false)
  })
})

describe('readDenials — form discrimination', () => {
  it('parses each of the four current-form decisions', async () => {
    const result = await readPresent(['deny', 'miss', 'gate-clear', 'hook-error'].map((decision) => line(decision, 'port:port:impl-agent', 'some command')).join(''))
    expect(result.entries.map((e) => e.decision)).toEqual(['deny', 'miss', 'gate-clear', 'hook-error'])
    expect(result.entries.every((e) => e.form === 'current')).toBe(true)
  })

  it.each([
    { name: 'a legacy three-field line', text: '2026-01-01T00:00:00Z\tsession-abc123\tgit push origin main\n', expected: { form: 'legacy', decision: null, subject: 'git push origin main' } },
    { name: 'a legacy line whose command contains a tab', text: '2026-01-01T00:00:00Z\tsession-abc123\tgit commit -m "a\tb"\n', expected: { form: 'legacy', subject: 'git commit -m "a\tb"' } },
    { name: 'a single-field line', text: 'not-a-real-line-at-all\n', expected: { form: 'malformed' } },
  ])('reads $name', async ({ text, expected }) => {
    expect((await readPresent(text)).entries[0]).toMatchObject(expected)
  })

  it('ignores a blank trailing line', async () => {
    expect((await readPresent(`${line('deny', 'port:port:impl-agent', 'cmd')}\n`)).entries).toHaveLength(1)
  })

  it('handles CRLF line endings identically to LF', async () => {
    const lf = line('deny', 'port:port:impl-agent', 'cmd') + line('miss', 'subagent:Explore', 'other', '2026-01-01T00:00:01Z')
    const resultLf = await readPresent(lf)
    const resultCrlf = await readPresent(lf.replace(/\n/g, '\r\n'))
    expect(resultCrlf.entries.map((e) => ({ ...e, raw: undefined }))).toEqual(resultLf.entries.map((e) => ({ ...e, raw: undefined })))
  })
})

describe('readDenials — actor ladder', () => {
  it.each([
    { name: 'stage-agent, doubled prefix', who: 'port:port:impl-agent', expected: { kind: 'stage-agent', agent: 'impl-agent' } },
    { name: 'subagent, single prefix, non-stage type', who: 'port:Explore', expected: { kind: 'subagent', agentType: 'Explore' } },
    { name: 'subagent-signal', who: 'subagent:some-signal', expected: { kind: 'subagent-signal', signal: 'some-signal' } },
    { name: 'session', who: 'session:abc-123', expected: { kind: 'session', sessionId: 'abc-123' } },
  ])('resolves $name', async ({ who, expected }) => {
    expect((await readPresent(line('deny', who, 'cmd'))).entries[0]?.actor).toEqual(expected)
  })

  it('resolves a legacy bare uuid as unattributed', async () => {
    const result = await readPresent('2026-01-01T00:00:00Z\tabc-uuid-not-prefixed\tgit push\n')
    expect(result.entries[0]?.actor).toEqual({ kind: 'unattributed', raw: 'abc-uuid-not-prefixed' })
  })
})

describe('readDenials — summary buckets', () => {
  it('keeps miss, gate-clear, and a session-actor deny out of agentDenials', async () => {
    const result = await readPresent(
      [
        line('deny', 'port:port:impl-agent', 'cmd-a'),
        line('deny', 'session:cockpit-session', 'cmd-b'),
        line('miss', 'port:some-tool', 'cmd-c'),
        line('gate-clear', 'port:port:revise-agent', 'cmd-d'),
        line('hook-error', '', 'cmd-e'),
      ].join(''),
    )
    expect(result.summary).toEqual({ agentDenials: 1, railDenials: 1, misses: 1, gateClears: 1, hookErrors: 1, legacy: 0, malformed: 0, total: 5 })
  })

  it('counts a subagent-signal deny into agentDenials, not railDenials', async () => {
    const result = await readPresent(line('deny', 'subagent:some-signal', 'cmd-a'))
    expect(result.summary).toEqual({ agentDenials: 1, railDenials: 0, misses: 0, gateClears: 0, hookErrors: 0, legacy: 0, malformed: 0, total: 1 })
  })

  it('caps entries at limit while summary.total counts every line', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => line('deny', 'port:port:impl-agent', `cmd-${i}`, `2026-01-01T00:00:0${i}Z`)).join('')
    const result = await readPresent(lines, { limit: 3 })
    expect(result.capped).toBe(true)
    expect(result.summary.total).toBe(10)
    // Oldest-first order preserved — the newest 3 lines, in file order.
    expect(result.entries.map((e) => e.subject)).toEqual(['cmd-7', 'cmd-8', 'cmd-9'])
  })
})
