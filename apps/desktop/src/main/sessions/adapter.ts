// readSessionState — the orchestration (#78): call the reader once, build
// the project index once, then per attributed session list
// `<sessionDir>/subagents/` and read each `*.meta.json` beside its sibling
// `.jsonl`. A pure consumer of the caller's repository list: reads no
// config (#74's), enumerates no worktrees (#77's), reconciles nothing
// against labels (#79's).
import { listDirectory, pathOps, readJsonFile, statPath } from '../platform'
import type { AgentRecord, MetaProblem, SessionRecord, SessionRef, SessionScan } from '../../shared/sessions/types'
import { activityOf, attributeSession, itemNumberOf, parseAgentMeta, sessionRole, stageOf } from './classify'
import type { RepoRef } from './classify'
import { buildProjectIndex, resolveSessionDir } from './locate'
import { createSdkSessionReader } from './sdk'
import type { SessionReader } from './sdk'

export interface ReadSessionStateParams {
  readonly repos: readonly RepoRef[]
  readonly claudeHome?: string
  readonly reader?: SessionReader
  readonly now?: () => Date
}

const AGENT_META_SUFFIX = '.meta.json'
const AGENT_ID_PREFIX = /^agent-/

function defaultClaudeHome(): string {
  const fromEnv = process.env['CLAUDE_CONFIG_DIR']
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return pathOps.expandHome('~/.claude')
}

/** Reads every `*.meta.json` under `subagentsDir`, pairing each with its
 *  sibling `.jsonl`'s mtime for `lastActivityAt`. Never throws on a
 *  malformed file — it lands in `unreadable` and every other agent in the
 *  same directory is read regardless. */
async function readAgents(
  sessionId: string,
  repoId: AgentRecord['repoId'],
  subagentsDir: string,
  now: Date,
): Promise<{ readonly agents: readonly AgentRecord[]; readonly unreadable: readonly MetaProblem[] }> {
  const listing = await listDirectory(subagentsDir)
  if (!listing.ok) return { agents: [], unreadable: [] }

  const agents: AgentRecord[] = []
  const unreadable: MetaProblem[] = []

  for (const entry of listing.value) {
    if (entry.kind !== 'file' || !entry.name.endsWith(AGENT_META_SUFFIX)) continue
    const agentId = entry.name.slice(0, -AGENT_META_SUFFIX.length).replace(AGENT_ID_PREFIX, '')
    const metaPath = pathOps.join(subagentsDir, entry.name)
    const jsonlPath = pathOps.join(subagentsDir, `agent-${agentId}.jsonl`)

    const metaResult = await readJsonFile<unknown>(metaPath)
    if (!metaResult.ok) {
      unreadable.push({ sessionId, agentId, kind: metaResult.kind, message: metaResult.message })
      continue
    }
    const parsed = parseAgentMeta(metaResult.value)
    if (!parsed.ok) {
      unreadable.push({ sessionId, agentId, kind: 'malformed', message: parsed.message })
      continue
    }

    // The sibling `.jsonl`'s mtime is the activity source (files.ts's
    // `modifiedAt`); a stat hiccup on it falls back to the session's own
    // last-modified time rather than dropping an otherwise-valid record.
    const stat = await statPath(jsonlPath)
    const lastActivityAt = stat.ok ? stat.value.modifiedAt : now.toISOString()
    const { idleMs, activity } = activityOf(lastActivityAt, now)

    agents.push({
      sessionId,
      repoId,
      agentId,
      agentType: parsed.value.agentType,
      stage: stageOf(parsed.value.agentType),
      model: parsed.value.model,
      description: parsed.value.description,
      itemNumber: itemNumberOf(parsed.value.description),
      worktreePath: parsed.value.worktreePath,
      worktreeBranch: parsed.value.worktreeBranch,
      spawnDepth: parsed.value.spawnDepth,
      lastActivityAt,
      idleMs,
      activity,
    })
  }

  return { agents, unreadable }
}

export async function readSessionState(params: ReadSessionStateParams): Promise<SessionScan> {
  const now = params.now ?? (() => new Date())
  const scannedAt = now().toISOString()
  const start = Date.now()
  const claudeHome = params.claudeHome ?? defaultClaudeHome()
  const reader = params.reader ?? createSdkSessionReader()

  const rawResult = await reader()
  if (!rawResult.ok) {
    return { ok: false, kind: rawResult.kind, message: rawResult.message, scannedAt }
  }

  const indexResult = await buildProjectIndex(claudeHome)
  if (!indexResult.ok) {
    return { ok: false, kind: indexResult.kind, message: indexResult.message, scannedAt }
  }

  const sessions: SessionRecord[] = []
  const agents: AgentRecord[] = []
  const unresolved: SessionRef[] = []
  const unreadable: MetaProblem[] = []
  let unattributed = 0

  for (const raw of rawResult.sessions) {
    const sessionDir = resolveSessionDir(raw.sessionId, indexResult.index)
    if (sessionDir === undefined) {
      unresolved.push({ sessionId: raw.sessionId })
      continue
    }

    const attribution = attributeSession(params.repos, raw.cwd)
    if (attribution.repoId === null) unattributed += 1

    // Descend into subagents/ only for a session that attributed to a
    // repository — that is what bounds the expensive half of the scan.
    const agentIds: string[] = []
    const agentTypes: string[] = []
    if (attribution.repoId !== null) {
      const subagentsDir = pathOps.join(sessionDir, 'subagents')
      const read = await readAgents(raw.sessionId, attribution.repoId, subagentsDir, now())
      for (const agent of read.agents) {
        agents.push(agent)
        agentIds.push(agent.agentId)
        agentTypes.push(agent.agentType)
      }
      unreadable.push(...read.unreadable)
    }

    const roleVerdict = sessionRole({ cwd: raw.cwd, firstPrompt: raw.firstPrompt }, agentTypes)
    const { idleMs, activity } = activityOf(raw.lastModified, now())

    sessions.push({
      sessionId: raw.sessionId,
      repoId: attribution.repoId,
      cwd: raw.cwd,
      worktreePath: attribution.worktreePath,
      role: roleVerdict.role,
      roleEvidence: roleVerdict.evidence,
      itemNumber: roleVerdict.itemNumber,
      customTitle: raw.customTitle,
      summary: raw.summary,
      firstPrompt: raw.firstPrompt,
      gitBranch: raw.gitBranch,
      lastActivityAt: raw.lastModified,
      idleMs,
      activity,
      agentIds,
    })
  }

  return {
    ok: true,
    sessions,
    agents,
    unattributed,
    unresolved,
    unreadable,
    scannedProjects: indexResult.scannedProjects,
    scanMs: Date.now() - start,
    scannedAt,
  }
}
