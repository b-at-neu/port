// readDenials: parses `.agents/denials.log` (PIPELINE.md → "Denial
// visibility") into the app's own denial model. The current four-field form
// and the legacy three-field form coexist in a real file (this repository's
// own log measured 322 current-form lines against ~444 legacy), so both are
// parsed rather than one being treated as noise.
import { git as defaultGit, pathOps as defaultPathOps, readTextFile } from '../platform'
import type { CommandResult, FileFailureKind, PathOps } from '../platform'
import type { AssertEqual } from '../../shared/assert-type'
import type { DenialActor, DenialDecision, DenialEntry, DenialsFailureKind, DenialSummary, DenialsRead } from '../../shared/local/types'

/** The same seam `worktrees.ts` declares — a `git` invocation is needed here
 *  only to resolve the base repository root (Decision 4), never to read the
 *  log itself. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<CommandResult>

export interface ReadDenialsParams {
  readonly repoRoot: string
  readonly git?: GitRunner
  /** The newest N lines kept in `entries`, oldest first — `summary` always
   *  counts the whole file regardless. Defaults to 500. */
  readonly limit?: number
  readonly now?: () => Date
  readonly pathOps?: PathOps
}

const DEFAULT_LIMIT = 500

/** Fails to compile if the platform layer's `FileFailureKind` changes
 *  without `DenialsFailureKind` (`shared/local/types.ts`) growing to match —
 *  the same pin `worktrees.ts` establishes for `LocalFailureKind`.
 *  `not-found` becomes `present: false` and a text read can never be
 *  `unparseable`, so both are excluded here. */
type FileFailureKindExcludingHandled = Exclude<FileFailureKind, 'not-found' | 'unparseable'>
export const _kindsCoverFileFailureKind: AssertEqual<DenialsFailureKind, FileFailureKindExcludingHandled> = true

/** `git rev-parse --git-common-dir` then `pathOps.dirname` of its resolved
 *  value — the hook writes to `<base repo root>/.agents/denials.log`, where
 *  the base root is one level up from the shared `.git` directory, so every
 *  worktree of a repository logs to the same file. Degrades to `repoRoot`
 *  itself on any failure — the common case is a plain checkout where the two
 *  are identical, so this is never a failure of the whole read. */
async function resolveBaseRoot(git: GitRunner, repoRoot: string, pathOps: PathOps): Promise<string> {
  const result = await git(['rev-parse', '--git-common-dir'], repoRoot)
  if (!result.ok) return repoRoot
  const common = result.stdout.trim()
  if (common === '') return repoRoot
  try {
    return pathOps.dirname(pathOps.resolveFrom(repoRoot, common))
  } catch {
    return repoRoot
  }
}

const CURRENT_DECISIONS: ReadonlySet<DenialDecision> = new Set(['deny', 'miss', 'gate-clear', 'hook-error'])

function isDenialDecision(value: string): value is DenialDecision {
  return CURRENT_DECISIONS.has(value as DenialDecision)
}

type StageAgentName = 'plan-agent' | 'impl-agent' | 'review-agent' | 'revise-agent'
const STAGE_AGENTS: ReadonlySet<StageAgentName> = new Set(['plan-agent', 'impl-agent', 'review-agent', 'revise-agent'])

function isStageAgent(value: string): value is StageAgentName {
  return STAGE_AGENTS.has(value as StageAgentName)
}

/** The doubled `port:port:<type>` prefix is real, not a typo — the hook
 *  writes `port:${agent_type}` and `agent_type` is itself plugin-namespaced
 *  (`port:impl-agent`). A leading `port:` is stripped once and a second is
 *  tolerated. */
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

/** Form discrimination is semantic, never positional: field count alone
 *  cannot tell a legacy line's tab-containing command from a current-form
 *  line, since the current form's subject is collapsed and capped at 500
 *  characters by the hook (never carries a tab), while a legacy line's
 *  subject is the raw, unmodified command. */
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

/** The buckets a consumer must not re-derive (Data & contracts): `deny` from
 *  a `stage-agent`/`subagent`/`subagent-signal` actor is `agentDenials`
 *  (`subagent-signal` is still known to be a subagent, just via a weaker
 *  attribution rung — PIPELINE.md's own ladder — so it counts the same way);
 *  `deny` from a `session` actor is `railDenials` — a rail held, never a
 *  missing permission — and never folded into `agentDenials`. `miss`/
 *  `gate-clear`/`hook-error` are never denials at all. */
function buildSummary(entries: readonly DenialEntry[]): DenialSummary {
  let agentDenials = 0
  let railDenials = 0
  let misses = 0
  let gateClears = 0
  let hookErrors = 0
  let legacy = 0
  let malformed = 0

  for (const entry of entries) {
    if (entry.form === 'legacy') legacy++
    if (entry.form === 'malformed') malformed++

    switch (entry.decision) {
      case 'miss':
        misses++
        break
      case 'gate-clear':
        gateClears++
        break
      case 'hook-error':
        hookErrors++
        break
      case 'deny':
        if (entry.actor?.kind === 'session') railDenials++
        else if (
          entry.actor?.kind === 'stage-agent' ||
          entry.actor?.kind === 'subagent' ||
          entry.actor?.kind === 'subagent-signal'
        )
          agentDenials++
        break
      default:
        break
    }
  }

  return { agentDenials, railDenials, misses, gateClears, hookErrors, legacy, malformed, total: entries.length }
}

/** An absent log is a distinct healthy state, never an error and never an
 *  empty `entries` list that reads as "no denials" — the whole point of a
 *  dedicated `present` flag. */
export async function readDenials(params: ReadDenialsParams): Promise<DenialsRead> {
  const git = params.git ?? ((args, cwd) => defaultGit(args, { cwd }))
  const pathOps = params.pathOps ?? defaultPathOps
  const now = params.now ?? (() => new Date())
  const limit = params.limit ?? DEFAULT_LIMIT
  const readAt = now().toISOString()

  const baseRoot = await resolveBaseRoot(git, params.repoRoot, pathOps)
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
  const summary = buildSummary(allEntries)
  const capped = allEntries.length > limit
  const entries = capped ? allEntries.slice(-limit) : allEntries

  return { ok: true, present: true, path, entries, summary, capped, readAt }
}
