import { describe, expect, it } from 'vitest'
import type { RepoId } from '../shared/repos'
import type { ReposListResponse } from '../shared/ipc'
import type { WorktreesReport } from '../shared/reclaimer/types'
import type { BoardSnapshot } from '../shared/board/types'
import type { TranscriptRead, TranscriptTailOpen, TranscriptTailPoll } from '../shared/sessions/transcript'
import {
  resolveBoardRefresh,
  resolveTranscriptRead,
  resolveTranscriptTailClose,
  resolveTranscriptTailOpen,
  resolveTranscriptTailPoll,
  resolveWorktreesReport,
} from './ipc'
import type { BoardRefreshDeps, TranscriptReadDeps, TranscriptTailDeps, WorktreesReportDeps } from './ipc'
import type { RegistryDeps } from './registry'

const REPO_ID = 'repo-1' as unknown as RepoId

const registryDeps: RegistryDeps = {
  registryDir: '/registry',
  git: () => {
    throw new Error('git should not be invoked directly by resolveWorktreesReport')
  },
  chooseDirectory: () => Promise.resolve(null),
}

const READY_ENTRY = {
  id: REPO_ID,
  path: '/repo',
  displayName: 'widgets',
  status: 'ready' as const,
  config: {
    repo: 'acme/widgets',
    owner: 'acme',
    name: 'widgets',
    branches: { integration: 'dev', production: 'main' },
    models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
    modules: { approvalGate: true, release: true, scope: true },
    reviewCycleCap: 3,
    vocabulary: {} as never,
    commands: { worktrees: 'node scripts/worktrees.mjs' },
  },
  diagnostics: [],
}

const NOT_READY_ENTRY = {
  id: REPO_ID,
  path: '/repo',
  displayName: 'widgets',
  problem: { kind: 'directory-missing' as const },
  diagnostics: [],
}

function depsWith(overrides: Partial<WorktreesReportDeps>): WorktreesReportDeps {
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [] } as ReposListResponse),
    readWorktreeReport: () => {
      throw new Error('readWorktreeReport should not be invoked in this case')
    },
    ...overrides,
  }
}

describe('resolveWorktreesReport', () => {
  it('rejects a missing id', async () => {
    await expect(resolveWorktreesReport(registryDeps, { id: undefined as unknown as RepoId }, depsWith({}))).rejects.toThrow(
      "'worktrees:report' requires a non-empty 'id'",
    )
  })

  it('rejects an empty id', async () => {
    await expect(resolveWorktreesReport(registryDeps, { id: '' as unknown as RepoId }, depsWith({}))).rejects.toThrow(
      "'worktrees:report' requires a non-empty 'id'",
    )
  })

  it('surfaces a registry that could not be listed', async () => {
    const deps = depsWith({
      listRepositories: () => Promise.resolve({ ok: false, kind: 'registry-unreadable', message: 'disk on fire' }),
    })
    await expect(resolveWorktreesReport(registryDeps, { id: REPO_ID }, deps)).rejects.toThrow(
      "'worktrees:report' could not list repositories: disk on fire",
    )
  })

  it('rejects an id with no matching repository', async () => {
    const deps = depsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [] }) })
    await expect(resolveWorktreesReport(registryDeps, { id: REPO_ID }, deps)).rejects.toThrow(
      `'worktrees:report' found no repository registered with id '${REPO_ID}'`,
    )
  })

  it('rejects a repository that is not ready', async () => {
    const deps = depsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [NOT_READY_ENTRY] }) })
    await expect(resolveWorktreesReport(registryDeps, { id: REPO_ID }, deps)).rejects.toThrow(
      "'worktrees:report' requires a 'ready' repository, got 'directory-missing'",
    )
  })

  it('reads the report for a ready repository, passing its resolved path and command through', async () => {
    const report: WorktreesReport = { ok: false, kind: 'timeout', message: 'node timed out after 60000ms', readAt: '2026-01-01T00:00:00.000Z' }
    let received: unknown
    const deps = depsWith({
      listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }),
      readWorktreeReport: (params) => {
        received = params
        return Promise.resolve(report)
      },
    })
    const result = await resolveWorktreesReport(registryDeps, { id: REPO_ID }, deps)
    expect(result).toBe(report)
    expect(received).toEqual({
      repoRoot: '/repo',
      worktreesCommand: 'node scripts/worktrees.mjs',
      git: registryDeps.git,
    })
  })
})

const FAKE_SNAPSHOT = { state: { repositories: [], sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: '2026-01-01T00:00:00.000Z' }, readAt: '2026-01-01T00:00:00.000Z' }, health: [], policy: { baseIntervalMs: { github: 60_000, sessions: 15_000, worktrees: 15_000, denials: 15_000 }, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: 30_000 }, emittedAt: '2026-01-01T00:00:00.000Z' } satisfies BoardSnapshot

function boardDepsWith(overrides: Partial<BoardRefreshDeps>): BoardRefreshDeps {
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [] } as ReposListResponse),
    refresh: () => Promise.resolve(FAKE_SNAPSHOT),
    ...overrides,
  }
}

function transcriptReadDepsWith(overrides: Partial<TranscriptReadDeps>): TranscriptReadDeps {
  return {
    openTranscript: () => {
      throw new Error('openTranscript should not be invoked in this case')
    },
    ...overrides,
  }
}

function tailDepsWith(overrides: Partial<TranscriptTailDeps>): TranscriptTailDeps {
  return {
    openTail: () => {
      throw new Error('openTail should not be invoked in this case')
    },
    pollTail: () => {
      throw new Error('pollTail should not be invoked in this case')
    },
    closeTail: () => {
      throw new Error('closeTail should not be invoked in this case')
    },
    ...overrides,
  }
}

describe('resolveTranscriptRead', () => {
  it('rejects a missing sessionId', async () => {
    await expect(resolveTranscriptRead({ sessionId: undefined as unknown as string, agentId: null }, transcriptReadDepsWith({}))).rejects.toThrow(
      "'transcript:read' requires a non-empty 'sessionId'",
    )
  })

  it('rejects an empty sessionId', async () => {
    await expect(resolveTranscriptRead({ sessionId: '', agentId: null }, transcriptReadDepsWith({}))).rejects.toThrow(
      "'transcript:read' requires a non-empty 'sessionId'",
    )
  })

  it('rejects an agentId that is neither a string nor null', async () => {
    await expect(resolveTranscriptRead({ sessionId: 's1', agentId: 42 as unknown as string }, transcriptReadDepsWith({}))).rejects.toThrow(
      "'transcript:read' requires 'agentId' to be a string or null",
    )
  })

  it('opens a cursor through openTranscript, returns its read, and discards the cursor', async () => {
    const read: TranscriptRead = { ok: true, source: {} as never, entries: [] }
    let received: unknown
    const deps = transcriptReadDepsWith({
      openTranscript: (params) => {
        received = params
        return Promise.resolve({ read, cursor: { path: '/t', sessionId: 's1', agentId: null, offset: 10, nextIndex: 0, recordCount: 0, malformedLines: 0, deriver: {} as never } })
      },
    })
    const result = await resolveTranscriptRead({ sessionId: 's1', agentId: null }, deps)
    expect(result).toBe(read)
    expect(received).toEqual({ sessionId: 's1', agentId: null })
  })

  it('surfaces a failed read as-is, with no cursor to discard', async () => {
    const read: TranscriptRead = { ok: false, kind: 'not-found', message: 'No transcript file at /t.', path: '/t' }
    const deps = transcriptReadDepsWith({
      openTranscript: () => Promise.resolve({ read, cursor: null }),
    })
    const result = await resolveTranscriptRead({ sessionId: 's1', agentId: null }, deps)
    expect(result).toBe(read)
  })
})

describe('resolveBoardRefresh', () => {
  it('rejects an id with no matching repository', async () => {
    const deps = boardDepsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [] }) })
    await expect(resolveBoardRefresh(registryDeps, { repoId: REPO_ID }, deps)).rejects.toThrow(
      `'board:refresh' found no repository registered with id '${REPO_ID}'`,
    )
  })

  it('rejects an unknown source', async () => {
    const deps = boardDepsWith({})
    await expect(resolveBoardRefresh(registryDeps, { source: 'bogus' as never }, deps)).rejects.toThrow(
      "'board:refresh' source must be one of github, sessions, worktrees, denials",
    )
  })

  it('surfaces a registry that could not be listed when repoId is present', async () => {
    const deps = boardDepsWith({ listRepositories: () => Promise.resolve({ ok: false, kind: 'registry-unreadable', message: 'disk on fire' }) })
    await expect(resolveBoardRefresh(registryDeps, { repoId: REPO_ID }, deps)).rejects.toThrow(
      "'board:refresh' could not list repositories: disk on fire",
    )
  })

  it('forwards a valid request to refresh() and returns its snapshot', async () => {
    const deps = boardDepsWith({ listRepositories: () => Promise.resolve({ ok: true, repositories: [READY_ENTRY] }), refresh: () => Promise.resolve(FAKE_SNAPSHOT) })
    const result = await resolveBoardRefresh(registryDeps, { repoId: REPO_ID, source: 'github' }, deps)
    expect(result).toBe(FAKE_SNAPSHOT)
  })

  it('an empty request (no repoId, no source) forces every source', async () => {
    let received: unknown
    const deps = boardDepsWith({
      refresh: (request) => {
        received = request
        return Promise.resolve(FAKE_SNAPSHOT)
      },
    })
    await resolveBoardRefresh(registryDeps, {}, deps)
    expect(received).toEqual({})
  })
})

describe('resolveTranscriptTailOpen', () => {
  it('rejects a missing sessionId', async () => {
    await expect(resolveTranscriptTailOpen({ sessionId: undefined as unknown as string, agentId: null }, tailDepsWith({}))).rejects.toThrow(
      "'transcript:tail:open' requires a non-empty 'sessionId'",
    )
  })

  it('rejects an empty sessionId', async () => {
    await expect(resolveTranscriptTailOpen({ sessionId: '', agentId: null }, tailDepsWith({}))).rejects.toThrow(
      "'transcript:tail:open' requires a non-empty 'sessionId'",
    )
  })

  it('rejects an agentId that is neither a string nor null', async () => {
    await expect(resolveTranscriptTailOpen({ sessionId: 's1', agentId: 42 as unknown as string }, tailDepsWith({}))).rejects.toThrow(
      "'transcript:tail:open' requires 'agentId' to be a string or null",
    )
  })

  it('passes a valid request through to openTail', async () => {
    const response: TranscriptTailOpen = { ok: true, tailId: 'tail-1', source: {} as never, entries: [] }
    let received: unknown
    const deps = tailDepsWith({
      openTail: (params) => {
        received = params
        return Promise.resolve(response)
      },
    })
    const result = await resolveTranscriptTailOpen({ sessionId: 's1', agentId: null }, deps)
    expect(result).toBe(response)
    expect(received).toEqual({ sessionId: 's1', agentId: null })
  })
})

describe('resolveTranscriptTailPoll', () => {
  it('rejects a missing tailId', async () => {
    await expect(resolveTranscriptTailPoll({ tailId: undefined as unknown as string }, tailDepsWith({}))).rejects.toThrow(
      "'transcript:tail:poll' requires a non-empty 'tailId'",
    )
  })

  it('rejects an empty tailId', async () => {
    await expect(resolveTranscriptTailPoll({ tailId: '' }, tailDepsWith({}))).rejects.toThrow("'transcript:tail:poll' requires a non-empty 'tailId'")
  })

  it('passes a valid request through to pollTail', async () => {
    const response: TranscriptTailPoll = { ok: true, source: {} as never, appended: [], patched: [], hasMore: false }
    let received: unknown
    const deps = tailDepsWith({
      pollTail: (params) => {
        received = params
        return Promise.resolve(response)
      },
    })
    const result = await resolveTranscriptTailPoll({ tailId: 'tail-1' }, deps)
    expect(result).toBe(response)
    expect(received).toEqual({ tailId: 'tail-1' })
  })
})

describe('resolveTranscriptTailClose', () => {
  it('rejects a missing tailId', () => {
    expect(() => resolveTranscriptTailClose({ tailId: undefined as unknown as string }, tailDepsWith({}))).toThrow(
      "'transcript:tail:close' requires a non-empty 'tailId'",
    )
  })

  it('passes a valid request through to closeTail', () => {
    let received: unknown
    const deps = tailDepsWith({
      closeTail: (params) => {
        received = params
      },
    })
    resolveTranscriptTailClose({ tailId: 'tail-1' }, deps)
    expect(received).toEqual({ tailId: 'tail-1' })
  })
})
