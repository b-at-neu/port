// Both the current four-field form and the legacy three-field form coexist in a real log, so both are parsed.
import { defaultGitRunner, resolveGitBaseRoot } from '../platform/git'
import { pathOps as defaultPathOps } from '../platform/paths'
import { readTextFile } from '../platform/files'
import type { FileFailureKind } from '../platform/files'
import type { GitRunner } from '../platform/git'
import type { PathOps } from '../platform/paths'
import type { AssertEqual } from '../../shared/assert-type'
import { summarizeDenials } from '../../shared/local/summary'
import type { DenialActor, DenialDecision, DenialEntry, DenialsFailureKind, DenialsRead } from '../../shared/local/types'

export type { GitRunner }

export interface ReadDenialsParams {
  readonly repoRoot: string
  readonly git?: GitRunner
  /** The newest N lines kept in `entries`; `summary` always counts the whole file. Defaults to 500. */
  readonly limit?: number
  readonly now?: () => Date
  readonly pathOps?: PathOps
}

const DEFAULT_LIMIT = 500

/** Fails to compile if `FileFailureKind` changes without `DenialsFailureKind` growing to match. */
type FileFailureKindExcludingHandled = Exclude<FileFailureKind, 'not-found' | 'unparseable'>
export const _kindsCoverFileFailureKind: AssertEqual<DenialsFailureKind, FileFailureKindExcludingHandled> = true

const CURRENT_DECISIONS: ReadonlySet<DenialDecision> = new Set(['deny', 'miss', 'gate-clear', 'hook-error'])

function isDenialDecision(value: string): value is DenialDecision {
  return CURRENT_DECISIONS.has(value as DenialDecision)
}

type StageAgentName = 'plan-agent' | 'impl-agent' | 'review-agent' | 'revise-agent'
const STAGE_AGENTS: ReadonlySet<StageAgentName> = new Set(['plan-agent', 'impl-agent', 'review-agent', 'revise-agent'])

function isStageAgent(value: string): value is StageAgentName {
  return STAGE_AGENTS.has(value as StageAgentName)
}

/** The doubled `port:port:<type>` prefix is real, not a typo — a leading `port:` is stripped once
 *  and a second is tolerated. */
function parseActor(raw: string): DenialActor {
  if (raw.startsWith('session:')) return { kind: 'session', sessionId: raw.slice('session:'.length) }
  if (raw.startsWith('subagent:')) return { kind: 'subagent-signal', signal: raw.slice('subagent:'.length) }
  if (raw.startsWith('port:')) {
    let rest = raw.slice('port:'.length)
    if (rest.startsWith('port:')) rest = rest.slice('port:'.length)
    if (isStageAgent(rest)) return { kind: 'stage-agent', agent: rest }
    return { kind: 'subagent', agentType: rest }
  }
  return { kind: 'unattributed', raw }
}

/** Form discrimination is semantic, never positional: field count alone cannot tell a legacy
 *  line's command from a current-form one. */
function parseLine(raw: string): DenialEntry {
  const fields = raw.split('\t')
  if (fields.length < 2) {
    return { raw, form: 'malformed', timestamp: null, decision: null, actor: null, subject: null }
  }
  const timestamp = fields[0] ?? null
  const second = fields[1] ?? ''
  if (isDenialDecision(second)) {
    const actorRaw = fields[2] ?? ''
    const subject = fields.slice(3).join('\t')
    return { raw, form: 'current', timestamp, decision: second, actor: parseActor(actorRaw), subject }
  }
  const who = second
  const command = fields.slice(2).join('\t')
  return { raw, form: 'legacy', timestamp, decision: null, actor: parseActor(who), subject: command }
}

/** An absent log is a distinct healthy state, never an error or an empty `entries` list. */
export async function readDenials(params: ReadDenialsParams): Promise<DenialsRead> {
  const git = params.git ?? defaultGitRunner()
  const pathOps = params.pathOps ?? defaultPathOps
  const now = params.now ?? (() => new Date())
  const limit = params.limit ?? DEFAULT_LIMIT
  const readAt = now().toISOString()

  const baseRoot = await resolveGitBaseRoot(git, params.repoRoot, pathOps)
  const path = pathOps.join(baseRoot, '.agents', 'denials.log')

  const fileResult = await readTextFile(path)
  if (!fileResult.ok) {
    if (fileResult.kind === 'not-found') {
      return { ok: true, present: false, path, readAt }
    }
    const kind = fileResult.kind === 'unparseable' ? 'io' : fileResult.kind
    return { ok: false, kind, message: fileResult.message, path, readAt }
  }

  const lines = fileResult.value.split(/\r?\n/).filter((line) => line !== '')
  const allEntries = lines.map(parseLine)
  const summary = summarizeDenials(allEntries)
  const capped = allEntries.length > limit
  const entries = capped ? allEntries.slice(-limit) : allEntries

  return { ok: true, present: true, path, entries, summary, capped, readAt }
}
