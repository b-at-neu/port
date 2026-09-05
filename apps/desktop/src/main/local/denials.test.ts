import { describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandResult } from '../platform'
import { readDenials } from './denials'
import type { GitRunner } from './denials'

const NOT_A_REPO: CommandResult = { ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'fatal: not a git repository' }
const now = () => new Date('2026-01-01T00:00:00.000Z')

async function makeRepoWithLog(logText: string | undefined): Promise<{ readonly root: string; readonly git: GitRunner }> {
  const root = await mkdtemp(join(tmpdir(), 'port-local-denials-'))
  if (logText !== undefined) {
    await mkdir(join(root, '.agents'), { recursive: true })
    await writeFile(join(root, '.agents', 'denials.log'), logText, 'utf8')
  }
  const git: GitRunner = () => Promise.resolve(NOT_A_REPO) // degrades to repoRoot itself
  return { root, git }
}

describe('readDenials — present / absent', () => {
  it('reports present: false, not ok: false, for a missing log', async () => {
    const { root, git } = await makeRepoWithLog(undefined)
    const result = await readDenials({ repoRoot: root, git, now })
    expect(result).toEqual({ ok: true, present: false, path: join(root, '.agents', 'denials.log'), readAt: now().toISOString() })
  })

  it('reports present: true with entries for an existing log', async () => {
    const { root, git } = await makeRepoWithLog('2026-01-01T00:00:00Z\tdeny\tport:port:impl-agent\tgit push origin main\n')
    const result = await readDenials({ repoRoot: root, git, now })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(result.entries).toHaveLength(1)
    expect(result.capped).toBe(false)
  })
})

describe('readDenials — form discrimination', () => {
  it('parses each of the four current-form decisions', async () => {
    const lines = ['deny', 'miss', 'gate-clear', 'hook-error']
      .map((decision) => `2026-01-01T00:00:00Z\t${decision}\tport:port:impl-agent\tsome command\n`)
      .join('')
    const { root, git } = await makeRepoWithLog(lines)
    const result = await readDenials({ repoRoot: root, git, now })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(result.entries.map((e) => e.decision)).toEqual(['deny', 'miss', 'gate-clear', 'hook-error'])
    expect(result.entries.every((e) => e.form === 'current')).toBe(true)
  })

  it('parses a legacy three-field line', async () => {
    const { root, git } = await makeRepoWithLog('2026-01-01T00:00:00Z\tsession-abc123\tgit push origin main\n')
    const result = await readDenials({ repoRoot: root, git, now })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(result.entries[0]).toMatchObject({ form: 'legacy', decision: null, subject: 'git push origin main' })
  })

  it('reads a legacy line whose command contains a tab as legacy, not malformed', async () => {
    const { root, git } = await makeRepoWithLog('2026-01-01T00:00:00Z\tsession-abc123\tgit commit -m "a\tb"\n')
    const result = await readDenials({ repoRoot: root, git, now })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(result.entries[0]?.form).toBe('legacy')
    expect(result.entries[0]?.subject).toBe('git commit -m "a\tb"')
  })

  it('reads a single-field line as malformed', async () => {
    const { root, git } = await makeRepoWithLog('not-a-real-line-at-all\n')
    const result = await readDenials({ repoRoot: root, git, now })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(result.entries[0]?.form).toBe('malformed')
  })

  it('ignores a blank trailing line', async () => {
    const { root, git } = await makeRepoWithLog('2026-01-01T00:00:00Z\tdeny\tport:port:impl-agent\tcmd\n\n')
    const result = await readDenials({ repoRoot: root, git, now })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(result.entries).toHaveLength(1)
  })

  it('handles CRLF line endings identically to LF', async () => {
    const lf = '2026-01-01T00:00:00Z\tdeny\tport:port:impl-agent\tcmd\n2026-01-01T00:00:01Z\tmiss\tsubagent:Explore\tother\n'
    const crlf = lf.replace(/\n/g, '\r\n')
    const a = await makeRepoWithLog(lf)
    const b = await makeRepoWithLog(crlf)
    const resultLf = await readDenials({ repoRoot: a.root, git: a.git, now })
    const resultCrlf = await readDenials({ repoRoot: b.root, git: b.git, now })
    if (!resultLf.ok || !resultLf.present || !resultCrlf.ok || !resultCrlf.present) throw new Error('expected present')
    expect(resultCrlf.entries.map((e) => ({ ...e, raw: undefined }))).toEqual(resultLf.entries.map((e) => ({ ...e, raw: undefined })))
  })
})

describe('readDenials — actor ladder', () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly who: string; readonly expect: unknown }> = [
    { name: 'stage-agent, doubled prefix', who: 'port:port:impl-agent', expect: { kind: 'stage-agent', agent: 'impl-agent' } },
    { name: 'subagent, single prefix, non-stage type', who: 'port:Explore', expect: { kind: 'subagent', agentType: 'Explore' } },
    { name: 'subagent-signal', who: 'subagent:some-signal', expect: { kind: 'subagent-signal', signal: 'some-signal' } },
    { name: 'session', who: 'session:abc-123', expect: { kind: 'session', sessionId: 'abc-123' } },
  ]

  for (const c of cases) {
    it(`resolves ${c.name}`, async () => {
      const { root, git } = await makeRepoWithLog(`2026-01-01T00:00:00Z\tdeny\t${c.who}\tcmd\n`)
      const result = await readDenials({ repoRoot: root, git, now })
      if (!result.ok || !result.present) throw new Error('expected present')
      expect(result.entries[0]?.actor).toEqual(c.expect)
    })
  }

  it('resolves a legacy bare uuid as unattributed', async () => {
    const { root, git } = await makeRepoWithLog('2026-01-01T00:00:00Z\tabc-uuid-not-prefixed\tgit push\n')
    const result = await readDenials({ repoRoot: root, git, now })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(result.entries[0]?.actor).toEqual({ kind: 'unattributed', raw: 'abc-uuid-not-prefixed' })
  })
})

describe('readDenials — summary buckets', () => {
  it('keeps miss, gate-clear, and a session-actor deny out of agentDenials', async () => {
    const lines = [
      '2026-01-01T00:00:00Z\tdeny\tport:port:impl-agent\tcmd-a\n',
      '2026-01-01T00:00:01Z\tdeny\tsession:cockpit-session\tcmd-b\n',
      '2026-01-01T00:00:02Z\tmiss\tport:some-tool\tcmd-c\n',
      '2026-01-01T00:00:03Z\tgate-clear\tport:port:revise-agent\tcmd-d\n',
      '2026-01-01T00:00:04Z\thook-error\t\tcmd-e\n',
    ].join('')
    const { root, git } = await makeRepoWithLog(lines)
    const result = await readDenials({ repoRoot: root, git, now })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(result.summary).toEqual({
      agentDenials: 1,
      railDenials: 1,
      misses: 1,
      gateClears: 1,
      hookErrors: 1,
      legacy: 0,
      malformed: 0,
      total: 5,
    })
  })

  it('counts a subagent-signal deny into agentDenials, not railDenials', async () => {
    const lines = ['2026-01-01T00:00:00Z\tdeny\tsubagent:some-signal\tcmd-a\n'].join('')
    const { root, git } = await makeRepoWithLog(lines)
    const result = await readDenials({ repoRoot: root, git, now })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(result.summary).toEqual({
      agentDenials: 1,
      railDenials: 0,
      misses: 0,
      gateClears: 0,
      hookErrors: 0,
      legacy: 0,
      malformed: 0,
      total: 1,
    })
  })

  it('caps entries at limit while summary.total counts every line', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `2026-01-01T00:00:0${i}Z\tdeny\tport:port:impl-agent\tcmd-${i}\n`).join('')
    const { root, git } = await makeRepoWithLog(lines)
    const result = await readDenials({ repoRoot: root, git, limit: 3, now })
    if (!result.ok || !result.present) throw new Error('expected present')
    expect(result.capped).toBe(true)
    expect(result.entries).toHaveLength(3)
    expect(result.summary.total).toBe(10)
    // Oldest-first order preserved — the newest 3 lines, in file order.
    expect(result.entries.map((e) => e.subject)).toEqual(['cmd-7', 'cmd-8', 'cmd-9'])
  })
})

describe('readDenials — file failures', () => {
  it('reports permission-denied rather than a silent empty read', async () => {
    const { root, git } = await makeRepoWithLog('2026-01-01T00:00:00Z\tdeny\tport:port:impl-agent\tcmd\n')
    const logPath = join(root, '.agents', 'denials.log')
    await chmod(logPath, 0o000)
    try {
      const result = await readDenials({ repoRoot: root, git, now })
      // Root may still be readable as a privileged test-runner user (some CI
      // containers run as root, where chmod 000 is not actually enforced) —
      // in that case this degrades to a skip rather than a false failure.
      if (result.ok) return
      expect(result.kind).toBe('permission-denied')
    } finally {
      await chmod(logPath, 0o644)
    }
  })

  it('reports too-large rather than a silent truncation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'port-local-denials-'))
    await mkdir(join(root, '.agents'), { recursive: true })
    // One byte past the platform layer's 16 MiB cap (main/platform/files.ts).
    await writeFile(join(root, '.agents', 'denials.log'), Buffer.alloc(16 * 1024 * 1024 + 1, '\n'))
    const git: GitRunner = () => Promise.resolve(NOT_A_REPO)
    const result = await readDenials({ repoRoot: root, git, now })
    expect(result).toMatchObject({ ok: false, kind: 'too-large' })
  })
})

describe('readDenials — integration', () => {
  it("reads this repository's real log, if one exists in this checkout", async () => {
    const result = await readDenials({ repoRoot: process.cwd() })
    if (!result.ok) throw new Error(`unexpected failure: ${JSON.stringify(result)}`)
    if (!result.present) return // No log yet in this checkout — nothing further to assert.

    const { summary } = result
    const parsed = summary.total - summary.malformed
    expect(parsed).toBeGreaterThanOrEqual(0)
    for (const bucket of [summary.agentDenials, summary.railDenials, summary.misses, summary.gateClears, summary.hookErrors, summary.legacy, summary.malformed]) {
      expect(bucket).toBeGreaterThanOrEqual(0)
    }
    expect(summary.agentDenials + summary.railDenials + summary.misses + summary.gateClears + summary.hookErrors).toBeLessThanOrEqual(summary.total)
  })
})
