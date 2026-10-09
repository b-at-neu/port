// Fixture mode's canned hosted-session data — the Session screen's own
// states, plus the entries `session:attach` replays for the streaming one.
import type { SessionControls, SessionModels } from '../../shared/hosting/controls'
import type { HostedSessionSnapshot, SessionAttachResult, SessionKey } from '../../shared/hosting/types'
import type { TranscriptEntry } from '../../shared/sessions/transcript'
import type { SearchResult } from '../../shared/search/types'
import type { AgentRecord, SessionRecord, SessionScan } from '../../shared/sessions/types'
import { WIDGETS_ID } from './repos'

export const STREAMING_KEY = 'fixture-session-streaming' as SessionKey
export const PERMISSION_KEY = 'fixture-session-permission' as SessionKey
export const ENDED_KEY = 'fixture-session-ended' as SessionKey
export const STARTING_KEY = 'fixture-session-starting' as SessionKey
export const QUESTION_KEY = 'fixture-session-question' as SessionKey
export const PLAN_KEY = 'fixture-session-plan' as SessionKey

const FIXTURE_CONTROLS: SessionControls = { permissionMode: 'default', model: 'sonnet', effort: null }

const FIXTURE_MODELS: SessionModels = {
  kind: 'ready',
  models: [
    { value: 'opus', displayName: 'Opus', description: 'Most capable, for complex work', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'sonnet', displayName: 'Sonnet', description: 'Balanced for everyday work', efforts: ['low', 'medium', 'high'] },
    { value: 'haiku', displayName: 'Haiku', description: 'Fastest, for simple tasks', efforts: [] },
  ],
}

const MINUTE = 60_000

function payload(text: string) {
  return { text, omittedChars: 0 }
}

export function fixtureAttachEntries(now: Date): readonly TranscriptEntry[] {
  const t = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * MINUTE).toISOString()
  return [
    { type: 'user-text', uuid: 'fixture-1', timestamp: t(4), text: payload('Add a loading state to the repositories table.') },
    { type: 'assistant-text', uuid: 'fixture-2', timestamp: t(3), text: payload("I'll add a `Skeleton` row while the query is pending.") },
    {
      type: 'tool-call',
      uuid: 'fixture-3',
      timestamp: t(2),
      name: 'Edit',
      headline: 'src/renderer/src/repositories/screen.tsx',
      input: payload('{"file_path":"src/renderer/src/repositories/screen.tsx"}'),
      result: { isError: false, payload: payload('Edit applied.') },
      diff: {
        path: 'src/renderer/src/repositories/screen.tsx',
        isNewFile: false,
        additions: 2,
        deletions: 1,
        hunks: [
          {
            oldStart: 10,
            oldLines: 1,
            newStart: 10,
            newLines: 2,
            lines: [
              { sign: 'del', text: '-  if (loading) return null' },
              { sign: 'add', text: '+  if (loading) return <Skeleton className="h-9 w-full" />' },
              { sign: 'add', text: '+  // loading state' },
            ],
          },
        ],
      },
    },
    { type: 'thinking', uuid: 'fixture-4', timestamp: t(1), text: payload('Checking whether any other screen already renders this pattern.') },
  ]
}

/** Kept out of `fixtureSessionSnapshots` — the permission dialog is app-wide,
 *  so this would pop up over every other screenshot target otherwise. */
export function fixturePermissionSnapshots(now: Date): readonly HostedSessionSnapshot[] {
  const t = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * MINUTE).toISOString()
  const capabilities = { kind: 'ready', request: { source: 'installed' }, commands: [], agents: [], plugin: { kind: 'loaded', path: '/home/you/.claude/plugins/port', version: '0.2.1' }, components: { kind: 'complete' }, slashCommands: [] } as const

  return [
    {
      sessionKey: PERMISSION_KEY,
      claudeSessionId: 'fixture-claude-2',
      repoId: WIDGETS_ID,
      phase: 'ready',
      origin: { kind: 'fresh' },
      startedAt: t(12),
      queuedAfterInterrupt: null,
      end: null,
      titled: null,
      pendingPermissions: [
        {
          permissionId: 'fixture-permission-1',
          toolName: 'Bash',
          input: { command: 'pnpm remove left-pad' },
          title: null,
          displayName: null,
          description: null,
          decisionReason: null,
          blockedPath: null,
          agentId: null,
          requestedAt: t(0),
          sessionGrant: null,
          interaction: null,
        },
      ],
      capabilities,
      title: 'Remove an unused dependency',
      rateLimit: null,
      controls: FIXTURE_CONTROLS,
      models: FIXTURE_MODELS,
      usage: null,
    },
  ]
}

const FIXTURE_USAGE = {
  costUsd: 0.42,
  inputTokens: 180_000,
  outputTokens: 12_000,
  cacheReadTokens: 15_000,
  cacheWriteTokens: 3_000,
  contextTokens: 84_000,
  contextWindow: 200_000,
  observedAt: new Date(0).toISOString(),
} as const

export function fixtureSessionSnapshots(now: Date): readonly HostedSessionSnapshot[] {
  const t = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * MINUTE).toISOString()
  const capabilities = { kind: 'ready', request: { source: 'installed' }, commands: [], agents: [], plugin: { kind: 'loaded', path: '/home/you/.claude/plugins/port', version: '0.2.1' }, components: { kind: 'complete' }, slashCommands: [] } as const

  return [
    {
      sessionKey: STREAMING_KEY,
      claudeSessionId: 'fixture-claude-1',
      repoId: WIDGETS_ID,
      phase: 'streaming',
      origin: { kind: 'fresh' },
      startedAt: t(5),
      queuedAfterInterrupt: null,
      end: null,
      titled: null,
      pendingPermissions: [],
      capabilities,
      title: 'Add a loading state to the repositories table',
      rateLimit: null,
      controls: FIXTURE_CONTROLS,
      models: FIXTURE_MODELS,
      usage: { ...FIXTURE_USAGE, observedAt: t(0) },
    },
    {
      sessionKey: ENDED_KEY,
      claudeSessionId: 'fixture-claude-3',
      repoId: WIDGETS_ID,
      phase: 'ended',
      origin: { kind: 'fresh' },
      startedAt: t(30),
      queuedAfterInterrupt: null,
      end: { reason: 'exit-nonzero', exitCode: 1, signal: null, message: 'Error: ENOENT, no such file or directory', diagnosis: 'cli-missing' },
      titled: null,
      pendingPermissions: [],
      capabilities,
      title: 'Fix the release script',
      rateLimit: null,
      controls: FIXTURE_CONTROLS,
      models: FIXTURE_MODELS,
      usage: null,
    },
    {
      sessionKey: STARTING_KEY,
      claudeSessionId: null,
      repoId: WIDGETS_ID,
      phase: 'starting',
      origin: { kind: 'fresh' },
      startedAt: t(0),
      queuedAfterInterrupt: null,
      end: null,
      titled: null,
      pendingPermissions: [],
      capabilities: { kind: 'pending', request: { source: 'installed' } },
      title: null,
      rateLimit: null,
      controls: FIXTURE_CONTROLS,
      models: { kind: 'pending' },
      usage: null,
    },
    {
      sessionKey: QUESTION_KEY,
      claudeSessionId: 'fixture-claude-4',
      repoId: WIDGETS_ID,
      phase: 'streaming',
      origin: { kind: 'fresh' },
      startedAt: t(2),
      queuedAfterInterrupt: null,
      end: null,
      titled: null,
      pendingPermissions: [
        {
          permissionId: 'fixture-permission-question',
          toolName: 'AskUserQuestion',
          input: {},
          title: null,
          displayName: null,
          description: null,
          decisionReason: null,
          blockedPath: null,
          agentId: null,
          requestedAt: t(0),
          sessionGrant: null,
          interaction: {
            kind: 'question',
            questions: [
              {
                question: 'Which approach should we take for the loading state?',
                header: 'Approach',
                multiSelect: false,
                options: [
                  { label: 'Skeleton rows', description: 'Matches the existing table pattern' },
                  { label: 'Spinner overlay', description: 'Simpler, less layout shift' },
                ],
              },
            ],
          },
        },
      ],
      capabilities,
      title: 'Add a loading state to the repositories table',
      rateLimit: null,
      controls: FIXTURE_CONTROLS,
      models: FIXTURE_MODELS,
      usage: null,
    },
    {
      sessionKey: PLAN_KEY,
      claudeSessionId: 'fixture-claude-5',
      repoId: WIDGETS_ID,
      phase: 'streaming',
      origin: { kind: 'fresh' },
      startedAt: t(3),
      queuedAfterInterrupt: null,
      end: null,
      titled: null,
      pendingPermissions: [
        {
          permissionId: 'fixture-permission-plan',
          toolName: 'ExitPlanMode',
          input: {},
          title: null,
          displayName: null,
          description: null,
          decisionReason: null,
          blockedPath: null,
          agentId: null,
          requestedAt: t(0),
          sessionGrant: null,
          interaction: {
            kind: 'plan',
            plan: '1. Add a `Skeleton` row while the repositories query is pending.\n2. Add a regression test covering the loading state.',
          },
        },
      ],
      capabilities,
      title: 'Add a loading state to the repositories table',
      rateLimit: null,
      controls: { permissionMode: 'plan', model: 'sonnet', effort: null },
      models: FIXTURE_MODELS,
      usage: null,
    },
  ]
}

export function fixtureSessionAttach(sessionKey: SessionKey, now: Date): SessionAttachResult {
  const snapshot = [...fixtureSessionSnapshots(now), ...fixturePermissionSnapshots(now)].find((candidate) => candidate.sessionKey === sessionKey)
  if (snapshot === undefined) return { ok: false, kind: 'unknown-session' }
  const entries = sessionKey === STREAMING_KEY ? fixtureAttachEntries(now) : []
  return { ok: true, snapshot, replay: [], droppedBefore: 0, entries, firstIndex: 0, partial: null, pendingSends: [], revision: entries.length }
}

export function fixtureSessionsScan(now: Date): Extract<SessionScan, { readonly ok: true }> {
  const t = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * MINUTE).toISOString()
  const sessions: readonly SessionRecord[] = [
    {
      sessionId: 'fixture-history-1',
      repoId: WIDGETS_ID,
      cwd: '/home/you/src/widgets',
      worktreePath: null,
      role: 'implement',
      roleEvidence: 'first-prompt',
      itemNumber: 305,
      customTitle: null,
      summary: 'Added the Worktrees tab to the Repositories screen.',
      firstPrompt: 'Build the Worktrees tab.',
      gitBranch: '305-worktrees-tab',
      lastActivityAt: t(90),
      idleMs: 90 * MINUTE,
      activity: 'dormant',
      agentIds: ['fixture-agent-1'],
    },
  ]
  const agents: readonly AgentRecord[] = [
    {
      sessionId: 'fixture-history-1',
      repoId: WIDGETS_ID,
      agentId: 'fixture-agent-1',
      agentType: 'port:impl-agent',
      stage: 'impl-agent',
      model: 'sonnet',
      description: 'implements #305',
      itemNumber: 305,
      worktreePath: '/home/you/src/widgets/.claude/worktrees/impl-305',
      worktreeBranch: '305-worktrees-tab',
      spawnDepth: 1,
      lastActivityAt: t(90),
      idleMs: 90 * MINUTE,
      activity: 'dormant',
    },
  ]
  return { ok: true, sessions, agents, unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 1, scanMs: 4, scannedAt: now.toISOString() }
}

export function fixtureSearchResult(now: Date): Extract<SearchResult, { readonly ok: true }> {
  void now
  return {
    ok: true,
    groups: [
      {
        sessionId: 'fixture-history-1',
        agentId: 'fixture-agent-1',
        repoId: WIDGETS_ID,
        label: 'implements #305',
        itemNumber: 305,
        idleMs: 90 * MINUTE,
        hitCount: 1,
        hits: [{ entryIndex: 0, kind: 'tool-call', toolName: 'Edit', field: 'headline', timestamp: new Date(now.getTime() - 90 * MINUTE).toISOString(), snippet: { text: 'Added the Worktrees tab component', matchStart: 10, matchLength: 9 } }],
      },
    ],
    inScope: 4,
    skippedByIndex: 2,
    read: 2,
    unreached: 0,
    complete: true,
    hitsTruncated: false,
    indexPersisted: true,
    tookMs: 12,
  }
}
