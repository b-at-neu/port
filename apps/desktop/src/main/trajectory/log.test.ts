import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../shared/repos'
import type { TickReport } from '../../shared/tick/types'
import { buildDesktopTickEvent, recordTick } from './log'
import type { GitRunner } from './log'

const REPO_ID = 'repo-1' as unknown as RepoId
const now = () => new Date('2026-01-01T00:00:00.000Z')

const degradingGit: GitRunner = () => Promise.resolve({ ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'fatal: not a git repository' })

function makeReport(overrides: Partial<TickReport> = {}): TickReport {
  return {
    repoId: REPO_ID,
    displayName: 'o/r',
    blind: null,
    actionable: [],
    held: [],
    claims: [],
    disabledStages: [],
    nextTickAt: null,
    observations: [],
    autoApprovals: [],
    ...overrides,
  }
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'port-trajectory-log-'))
}

describe('buildDesktopTickEvent', () => {
  it('maps a TickReport into the line recordTick appends', () => {
    const report = makeReport({
      actionable: [{ number: 42, kind: 'issue', trigger: 'ready', agent: 'plan', unchecked: false, cycle: null }],
      held: [{ number: 7, kind: 'issue', trigger: 'planApproved', reason: 'contended', contention: { blocker: 9, blockerStage: 'in progress', depth: 2, paths: ['a.ts'] }, escalation: null }],
      claims: [{ number: 9, kind: 'issue', inFlight: 'inProgress', class: 'matched', retryKey: null }],
    })

    const event = buildDesktopTickEvent({ repo: 'o/r', report, now })

    expect(event).toEqual({
      v: 1,
      ts: now().toISOString(),
      repo: 'o/r',
      repoId: REPO_ID,
      dispatch: [{ item: 42, stage: 'plan-agent', agent: 'plan' }],
      held: [{ item: 7, reason: 'contended', contention: { blocker: 9, blockerStage: 'in progress', depth: 2, paths: ['a.ts'] }, trigger: 'planApproved' }],
      claims: [{ item: 9, class: 'matched' }],
      blind: null,
    })
  })

  it('carries a blind report through unchanged, never folding it into an empty dispatch', () => {
    const report = makeReport({ blind: { reason: 'not-ready' } })

    const event = buildDesktopTickEvent({ repo: 'o/r', report, now })

    expect(event.blind).toEqual({ reason: 'not-ready' })
    expect(event.dispatch).toEqual([])
  })
})

describe('recordTick', () => {
  it('appends one JSON line per call, readable back as the same event', async () => {
    const root = await makeTempDir()
    const event = buildDesktopTickEvent({ repo: 'o/r', report: makeReport(), now })

    await recordTick(root, event, { git: degradingGit })
    await recordTick(root, { ...event, ts: '2026-01-01T00:05:00.000Z' }, { git: degradingGit })

    const content = await readFile(join(root, '.agents', 'desktop-events.jsonl'), 'utf8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(2)
    const [firstLine] = lines
    expect(JSON.parse(firstLine ?? '')).toEqual(event)
  })

  it('rotates to desktop-events.prev.jsonl at the 8 MB cap', async () => {
    const root = await makeTempDir()
    await mkdir(join(root, '.agents'), { recursive: true })
    await writeFile(join(root, '.agents', 'desktop-events.jsonl'), 'x'.repeat(9 * 1024 * 1024))

    const event = buildDesktopTickEvent({ repo: 'o/r', report: makeReport(), now })
    await recordTick(root, event, { git: degradingGit })

    const prevContent = await readFile(join(root, '.agents', 'desktop-events.prev.jsonl'), 'utf8')
    expect(prevContent.length).toBeGreaterThan(8 * 1024 * 1024)
  })

  it('swallows a write failure rather than throwing or rejecting', async () => {
    const root = await makeTempDir()
    const throwingGit: GitRunner = () => {
      throw new Error('boom')
    }
    const event = buildDesktopTickEvent({ repo: 'o/r', report: makeReport(), now })

    await expect(recordTick(root, event, { git: throwingGit })).resolves.toBeUndefined()
  })
})
