// Fixture mode's canned hosted-session data — the Session screen's own
// states. Transcript entries live in `./entries`, split out to keep this file under the line limit.
import type { SessionControls, SessionModels } from '@/utils/hosting/controls'
import type { HostedSessionSnapshot, SessionAttachResult, SessionHistory, SessionKey } from '@/types/hosting'
import type { SessionWorkspace } from '@/types/workspace'
import type { SearchResult } from '@/types/search'
import type { AgentRecord, SessionRecord, SessionScan } from '@/types/sessions'
import { WIDGETS_ID } from './repos'
import { fixtureAttachEntries, fixtureHistoryEntries } from './entries'

/** Matches the board fixture's `fixture-stage-impl-38` dispatch record, so that item's current-phase line shows live elapsed time and cost. */
export const STAGE_IMPL_38_KEY = 'fixture-stage-impl-38' as SessionKey

/** A live implementation session for the board fixture's blocked item, carrying its `BLOCKED:` hand-back. */
export const STAGE_IMPL_51_KEY = 'fixture-stage-impl-51' as SessionKey
/** A live plan session for the board fixture's queued item, dispatched before its agent swaps a label. */
export const STAGE_PLAN_44_KEY = 'fixture-stage-plan-44' as SessionKey

export const STREAMING_KEY = 'fixture-session-streaming' as SessionKey
export const PERMISSION_KEY = 'fixture-session-permission' as SessionKey
export const ENDED_KEY = 'fixture-session-ended' as SessionKey
export const STARTING_KEY = 'fixture-session-starting' as SessionKey
export const QUESTION_KEY = 'fixture-session-question' as SessionKey
export const PLAN_KEY = 'fixture-session-plan' as SessionKey
export const RESUMED_KEY = 'fixture-session-resumed' as SessionKey

const NON_WORKTREE_WORKSPACE: SessionWorkspace = { folder: '/home/you/src/widgets', root: '/home/you/src/widgets', worktree: null, base: null }
const WORKTREE_WORKSPACE: SessionWorkspace = {
  folder: '/home/you/src/widgets/.claude/worktrees/session-ab12cd',
  root: '/home/you/src/widgets',
  worktree: { path: '/home/you/src/widgets/.claude/worktrees/session-ab12cd', branch: 'session/ab12cd' },
  base: { sha: '3eb526c', label: 'session/ab12cd' },
}

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
      workspace: NON_WORKTREE_WORKSPACE,
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
          protectedPath: null,
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
      backgroundTasks: [],
      stage: null,
      lastResult: null,
      operatorJoinedAt: null,
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

  const stageImpl38: HostedSessionSnapshot = {
    sessionKey: STAGE_IMPL_38_KEY,
    claudeSessionId: 'fixture-session-impl-38',
    repoId: WIDGETS_ID,
    workspace: WORKTREE_WORKSPACE,
    phase: 'streaming',
    origin: { kind: 'fresh' },
    startedAt: t(2),
    queuedAfterInterrupt: null,
    end: null,
    titled: null,
    pendingPermissions: [],
    capabilities,
    title: '#38 retry failed webhook deliveries',
    rateLimit: null,
    controls: FIXTURE_CONTROLS,
    models: FIXTURE_MODELS,
    usage: { ...FIXTURE_USAGE, costUsd: 0.42, observedAt: t(0) },
    backgroundTasks: [],
    stage: { agent: 'impl', number: 38, kind: 'issue', trigger: 'inProgress' },
    lastResult: null,
    operatorJoinedAt: t(1),
  }

  return [
    {
      sessionKey: STREAMING_KEY,
      claudeSessionId: 'fixture-claude-1',
      repoId: WIDGETS_ID,
      workspace: WORKTREE_WORKSPACE,
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
      backgroundTasks: [
        { taskId: 'fixture-task-1', type: 'bash', description: 'pnpm --filter @port/desktop screenshots', toolUseId: null },
        { taskId: 'fixture-task-2', type: 'agent', description: 'Checking the release checklist', toolUseId: null },
      ],
      stage: null,
      lastResult: null,
      operatorJoinedAt: null,
    },
    {
      sessionKey: ENDED_KEY,
      claudeSessionId: 'fixture-claude-3',
      repoId: WIDGETS_ID,
      workspace: NON_WORKTREE_WORKSPACE,
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
      usage: { costUsd: 1.18, inputTokens: 420_000, outputTokens: 28_000, cacheReadTokens: 35_000, cacheWriteTokens: 8_000, contextTokens: 190_000, contextWindow: 200_000, observedAt: t(29) },
      backgroundTasks: [],
      stage: null,
      lastResult: null,
      operatorJoinedAt: null,
    },
    {
      sessionKey: STARTING_KEY,
      claudeSessionId: null,
      repoId: WIDGETS_ID,
      workspace: NON_WORKTREE_WORKSPACE,
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
      backgroundTasks: [],
      stage: null,
      lastResult: null,
      operatorJoinedAt: null,
    },
    {
      sessionKey: QUESTION_KEY,
      claudeSessionId: 'fixture-claude-4',
      repoId: WIDGETS_ID,
      workspace: NON_WORKTREE_WORKSPACE,
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
          protectedPath: null,
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
      backgroundTasks: [],
      stage: null,
      lastResult: null,
      operatorJoinedAt: null,
    },
    {
      sessionKey: PLAN_KEY,
      claudeSessionId: 'fixture-claude-5',
      repoId: WIDGETS_ID,
      workspace: NON_WORKTREE_WORKSPACE,
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
          protectedPath: null,
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
      backgroundTasks: [],
      stage: null,
      lastResult: null,
      operatorJoinedAt: null,
    },
    stageImpl38,
    {
      ...stageImpl38,
      sessionKey: STAGE_IMPL_51_KEY,
      claudeSessionId: 'fixture-session-impl-51',
      phase: 'ready',
      title: '#51 backfill order totals for Q3',
      usage: null,
      stage: { agent: 'impl', number: 51, kind: 'issue', trigger: 'planApproved' },
      lastResult: {
        subtype: 'success',
        isError: false,
        text: "BLOCKED: The Q3 ledger export has no currency column. Should totals use the account's default currency or skip mixed-currency orders?",
        at: t(1),
      },
      operatorJoinedAt: null,
    },
    {
      ...stageImpl38,
      sessionKey: STAGE_PLAN_44_KEY,
      claudeSessionId: 'fixture-session-plan-44',
      startedAt: t(0),
      title: '#44 show the build number in the footer',
      usage: null,
      stage: { agent: 'plan', number: 44, kind: 'issue', trigger: 'ready' },
      operatorJoinedAt: null,
    },
    {
      sessionKey: RESUMED_KEY,
      claudeSessionId: 'fixture-claude-6',
      repoId: WIDGETS_ID,
      workspace: NON_WORKTREE_WORKSPACE,
      phase: 'ready',
      origin: { kind: 'resumed', from: 'fixture-history-1' },
      startedAt: t(1),
      queuedAfterInterrupt: null,
      end: null,
      titled: null,
      pendingPermissions: [],
      capabilities,
      title: 'Build the Worktrees tab',
      rateLimit: null,
      controls: FIXTURE_CONTROLS,
      models: FIXTURE_MODELS,
      usage: null,
      backgroundTasks: [],
      stage: null,
      lastResult: null,
      operatorJoinedAt: null,
    },
  ]
}

export function fixtureSessionAttach(sessionKey: SessionKey, now: Date): SessionAttachResult {
  const snapshot = [...fixtureSessionSnapshots(now), ...fixturePermissionSnapshots(now)].find((candidate) => candidate.sessionKey === sessionKey)
  if (snapshot === undefined) return { ok: false, kind: 'unknown-session' }
  const entries = sessionKey === STREAMING_KEY ? fixtureAttachEntries(now) : []
  const history: SessionHistory = sessionKey === RESUMED_KEY ? { kind: 'loaded', entries: fixtureHistoryEntries(now), omittedBefore: 0, sourceSessionId: 'fixture-history-1' } : { kind: 'none' }
  return { ok: true, snapshot, replay: [], droppedBefore: 0, entries, firstIndex: 0, partial: null, pendingSends: [], revision: entries.length, history }
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
    {
      sessionId: 'fixture-history-2',
      repoId: WIDGETS_ID,
      cwd: '/home/you/src/widgets',
      worktreePath: null,
      role: 'other',
      roleEvidence: null,
      itemNumber: null,
      customTitle: null,
      summary: 'Investigated a flaky screenshot capture.',
      firstPrompt: 'Why is the history screenshot flaky?',
      gitBranch: null,
      lastActivityAt: t(120),
      idleMs: 120 * MINUTE,
      activity: 'dormant',
      agentIds: [],
    },
    {
      sessionId: 'fixture-history-3',
      repoId: WIDGETS_ID,
      cwd: '/home/you/src/widgets',
      worktreePath: null,
      role: 'other',
      roleEvidence: null,
      itemNumber: null,
      customTitle: null,
      summary: 'Renamed a leftover fixture constant.',
      firstPrompt: 'Rename FIXTURE_OLD to FIXTURE_NEW.',
      gitBranch: null,
      lastActivityAt: t(150),
      idleMs: 150 * MINUTE,
      activity: 'dormant',
      agentIds: [],
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
