// Pure merge of every source that knows a session worked on a ticket into per-phase links — renderer-safe, no I/O.
import type { HostedSessionSnapshot } from '@/types/hosting'
import type { SessionIndexEntry } from '@/types/session-index'
import type { PhaseKey, StageLinkTarget, TicketSessionLink, TicketSessions } from '@/types/board'
import type { PortStageAgent } from '@/types/sessions'
import type { ReconciledItem, StageEntry, WorkSession } from '@/types/state'
import type { StageTag } from '@/types/stage-session'
import type { StageAgent } from '@/types/tick'
import type { RepoId } from '@/utils/repos'
import { phaseOfStage } from '@/renderer/board/phase-model'

interface TicketSessionsParams {
  readonly repoId: RepoId
  readonly targets: readonly StageLinkTarget[]
  readonly index: readonly SessionIndexEntry[]
  readonly snapshots: readonly HostedSessionSnapshot[]
  readonly issue: ReconciledItem | null
  readonly pullRequest: ReconciledItem | null
}

interface PlacedLink {
  readonly phase: PhaseKey | null
  readonly link: TicketSessionLink
}

const AGENT_PHASE: Readonly<Record<StageAgent, PhaseKey>> = { plan: 'plan', impl: 'implement', review: 'review', revise: 'revision' }

const TERMINAL_AGENT: Readonly<Record<PortStageAgent, StageAgent>> = { 'plan-agent': 'plan', 'impl-agent': 'impl', 'review-agent': 'review', 'revise-agent': 'revise' }

function targeted(tag: StageTag, targets: readonly StageLinkTarget[]): boolean {
  return targets.some((target) => target.number === tag.number && target.kind === tag.kind)
}

function stagePhase(tag: StageTag): PhaseKey {
  return phaseOfStage(tag.trigger, tag.kind) ?? AGENT_PHASE[tag.agent]
}

function byTime(a: PlacedLink, b: PlacedLink): number {
  return Date.parse(a.link.at) - Date.parse(b.link.at)
}

function stageLinkOf(tag: StageTag, entry: SessionIndexEntry | null, snapshot: HostedSessionSnapshot | null): PlacedLink {
  const live = snapshot !== null && snapshot.phase !== 'ended'
  const state: TicketSessionLink['state'] = live ? 'live' : entry === null ? 'started' : entry.endedAt !== null ? 'ended' : 'started'
  const link: TicketSessionLink = {
    key: snapshot !== null && live ? snapshot.sessionKey : (entry?.claudeSessionId ?? snapshot?.sessionKey ?? ''),
    who: { kind: 'stage', agent: tag.agent },
    state,
    at: entry?.startedAt ?? snapshot?.startedAt ?? '',
    endedAt: live ? null : (entry?.endedAt ?? null),
    costUsd: live ? (snapshot.usage?.costUsd ?? entry?.costUsd ?? null) : (entry?.costUsd ?? null),
    operatorJoined: (entry?.operatorJoinedAt ?? snapshot?.operatorJoinedAt ?? null) !== null,
    title: entry?.title ?? snapshot?.title ?? null,
    open: live ? { kind: 'session', sessionKey: snapshot.sessionKey } : { kind: 'transcript', sessionId: entry?.claudeSessionId ?? snapshot?.claudeSessionId ?? '', agentId: null },
  }
  return { phase: stagePhase(tag), link }
}

function stageLinks(params: TicketSessionsParams, liveById: ReadonlyMap<string, HostedSessionSnapshot>): { readonly placed: PlacedLink[]; readonly usedIds: Set<string> } {
  const placed: PlacedLink[] = []
  const usedIds = new Set<string>()
  const usedKeys = new Set<string>()

  for (const entry of params.index) {
    if (entry.stage === null || entry.repoId !== params.repoId || !targeted(entry.stage, params.targets)) continue
    const snapshot = liveById.get(entry.claudeSessionId) ?? null
    placed.push(stageLinkOf(entry.stage, entry, snapshot))
    usedIds.add(entry.claudeSessionId)
    if (snapshot !== null) usedKeys.add(snapshot.sessionKey)
  }

  for (const snapshot of params.snapshots) {
    const tag = snapshot.stage
    if (tag === null || snapshot.phase === 'ended' || snapshot.repoId !== params.repoId || !targeted(tag, params.targets)) continue
    if (usedKeys.has(snapshot.sessionKey) || (snapshot.claudeSessionId !== null && usedIds.has(snapshot.claudeSessionId))) continue
    placed.push(stageLinkOf(tag, null, snapshot))
    if (snapshot.claudeSessionId !== null) usedIds.add(snapshot.claudeSessionId)
  }

  for (const item of [params.issue, params.pullRequest]) {
    for (const agent of item?.agents ?? []) {
      if (agent.stage === null || usedIds.has(agent.sessionId)) continue
      const stage = TERMINAL_AGENT[agent.stage]
      placed.push({
        phase: AGENT_PHASE[stage],
        link: {
          key: `agent-${agent.agentId}`,
          who: { kind: 'stage', agent: stage },
          state: 'seen',
          at: agent.lastActivityAt,
          endedAt: null,
          costUsd: null,
          operatorJoined: false,
          title: null,
          open: { kind: 'transcript', sessionId: agent.sessionId, agentId: agent.agentId },
        },
      })
    }
  }
  return { placed, usedIds }
}

function historyOf(item: ReconciledItem | null): readonly (StageEntry & { readonly itemKind: ReconciledItem['kind'] })[] {
  return (item?.stageHistory ?? []).map((entry) => ({ ...entry, itemKind: item?.kind ?? 'issue' }))
}

/** The phase the ticket was in when a session ran: the latest stage entry at or before it, across both items. */
function phaseAt(time: number, history: readonly (StageEntry & { readonly itemKind: ReconciledItem['kind'] })[]): PhaseKey | null {
  let latest: (typeof history)[number] | null = null
  for (const entry of history) {
    const at = Date.parse(entry.at)
    if (Number.isNaN(at) || at > time) continue
    if (latest === null || at >= Date.parse(latest.at)) latest = entry
  }
  return latest === null ? null : phaseOfStage(latest.key, latest.itemKind)
}

function manualLinks(params: TicketSessionsParams, liveById: ReadonlyMap<string, HostedSessionSnapshot>, usedIds: ReadonlySet<string>): PlacedLink[] {
  const indexById = new Map(params.index.map((entry) => [entry.claudeSessionId, entry] as const))
  const history = [...historyOf(params.issue), ...historyOf(params.pullRequest)]
  const seen = new Set<string>()
  const placed: PlacedLink[] = []
  const sessions: readonly WorkSession[] = [...(params.issue?.workSessions ?? []), ...(params.pullRequest?.workSessions ?? [])]
  for (const work of sessions) {
    if (usedIds.has(work.sessionId) || seen.has(work.sessionId)) continue
    seen.add(work.sessionId)
    const entry = indexById.get(work.sessionId) ?? null
    const snapshot = liveById.get(work.sessionId) ?? null
    const live = snapshot !== null
    const at = entry?.startedAt ?? work.lastActivityAt
    const state: TicketSessionLink['state'] = live ? 'live' : entry === null ? 'seen' : entry.endedAt !== null ? 'ended' : 'started'
    placed.push({
      phase: phaseAt(Date.parse(at), history),
      link: {
        key: work.sessionId,
        who: { kind: 'you' },
        state,
        at,
        endedAt: live ? null : (entry?.endedAt ?? null),
        costUsd: live ? (snapshot.usage?.costUsd ?? entry?.costUsd ?? null) : (entry?.costUsd ?? null),
        operatorJoined: false,
        title: work.title,
        open: live ? { kind: 'session', sessionKey: snapshot.sessionKey } : { kind: 'transcript', sessionId: work.sessionId, agentId: null },
      },
    })
  }
  return placed
}

export function ticketSessionsFor(params: TicketSessionsParams): TicketSessions {
  const liveById = new Map<string, HostedSessionSnapshot>()
  for (const snapshot of params.snapshots) {
    if (snapshot.claudeSessionId !== null && snapshot.phase !== 'ended') liveById.set(snapshot.claudeSessionId, snapshot)
  }
  const { placed: stage, usedIds } = stageLinks(params, liveById)
  const all = [...stage, ...manualLinks(params, liveById, usedIds)].sort(byTime)

  const byPhase: Partial<Record<PhaseKey, TicketSessionLink[]>> = {}
  const unplaced: TicketSessionLink[] = []
  for (const { phase, link } of all) {
    if (phase === null) unplaced.push(link)
    else (byPhase[phase] ??= []).push(link)
  }
  return { byPhase, unplaced }
}
