// A missing field, a non-array `candidates`, or an unknown `state` fails the whole payload,
// naming the field — never a partial list.
import type { PathOps } from '@/types/platform'
import type { CorrelationRung } from '@/types/local'
import type { ForcedActionsState, PurgeCause, PurgeOutcome, ReclaimedWorktree, WorktreeState } from '@/types/reclaimer'
import { WORKTREE_STATES } from '@/types/reclaimer'
import { isRecord } from '@/main/guards'

const RUNGS: ReadonlySet<string> = new Set<CorrelationRung>(['upstream-branch', 'branch-name', 'directory-basename', 'head-subject'])
const STATES: ReadonlySet<string> = new Set<string>(WORKTREE_STATES)

interface ParsedWorktree {
  readonly path: string
  readonly branch: string | null
  readonly head: string | null
  readonly state: WorktreeState
  readonly reason: string
  readonly issue: number | null
  readonly rung: CorrelationRung | null
  readonly locked: boolean
  readonly lockReason: string | null
  readonly dirtyFiles: number
  readonly otherwiseReclaimable: boolean
}

type ParsedReport =
  | {
      readonly ok: true
      readonly mainRoot: string
      readonly integrationRef: string
      readonly forcedActions: ForcedActionsState
      readonly worktrees: readonly ParsedWorktree[]
      readonly orphanDirs: readonly string[]
      readonly registered: number
      readonly byState: Readonly<Partial<Record<WorktreeState, number>>>
    }
  | { readonly ok: false; readonly message: string }

function fail(message: string): ParsedReport {
  return { ok: false, message }
}

function stringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function parseCandidate(raw: unknown, index: number, pathOps: PathOps, pathScope: boolean): ParsedWorktree | string {
  if (!isRecord(raw)) return `candidates[${index}] is not an object`

  const path = raw.path
  if (typeof path !== 'string' || path === '') return `candidates[${index}].path is missing or not a string`

  const branch = raw.branch
  if (!stringOrNull(branch)) return `candidates[${index}].branch is not a string or null`

  const head = raw.head
  if (!stringOrNull(head)) return `candidates[${index}].head is not a string or null`

  const state = raw.state
  if (typeof state !== 'string' || !STATES.has(state)) {
    return `candidates[${index}].state is '${String(state)}', outside the known WORKTREE_STATES vocabulary`
  }

  const reason = raw.reason
  if (typeof reason !== 'string') return `candidates[${index}].reason is missing or not a string`

  const rung = raw.rung
  if (!(rung === null || (typeof rung === 'string' && RUNGS.has(rung)))) {
    return `candidates[${index}].rung is ${JSON.stringify(rung)}, not a known correlation rung or null`
  }

  const issue = raw.issue
  if (!(issue === null || typeof issue === 'number')) return `candidates[${index}].issue is not a number or null`

  const locked = raw.locked
  if (typeof locked !== 'boolean') return `candidates[${index}].locked is missing or not a boolean`

  const lockReason = raw.lockReason
  if (!stringOrNull(lockReason)) return `candidates[${index}].lockReason is not a string or null`

  const dirtyFiles = raw.dirtyFiles
  if (typeof dirtyFiles !== 'number') return `candidates[${index}].dirtyFiles is missing or not a number`

  // A script that predates `pathScope` never emits it, and fails toward offering nothing.
  const otherwiseRemovable = raw.otherwiseRemovable
  if (pathScope && typeof otherwiseRemovable !== 'boolean') return `candidates[${index}].otherwiseRemovable is missing or not a boolean`

  return {
    path: pathOps.toNative(path),
    branch,
    head,
    state: state as WorktreeState,
    reason,
    issue,
    rung: rung as CorrelationRung | null,
    locked,
    lockReason,
    dirtyFiles,
    otherwiseReclaimable: pathScope && otherwiseRemovable === true,
  }
}

// Every path is run through `pathOps.toNative` — the script emits `C:/Users/…`-style paths even on Windows.
export function parseReportPayload(stdout: string, pathOps: PathOps): ParsedReport {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return fail("the script's stdout was not valid JSON")
  }
  if (!isRecord(value)) return fail("the script's stdout was not a JSON object")

  const mainRoot = value.mainRoot
  if (typeof mainRoot !== 'string' || mainRoot === '') return fail('mainRoot is missing or not a string')

  const integrationRef = value.integrationRef
  if (typeof integrationRef !== 'string' || integrationRef === '') return fail('integrationRef is missing or not a string')

  const rawCandidates = value.candidates
  if (!Array.isArray(rawCandidates)) return fail('candidates is missing or not an array')

  const pathScope = value.pathScope === true

  const worktrees: ParsedWorktree[] = []
  for (const [index, raw] of rawCandidates.entries()) {
    const parsed = parseCandidate(raw, index, pathOps, pathScope)
    if (typeof parsed === 'string') return fail(parsed)
    worktrees.push(parsed)
  }

  const rawOrphanDirs = value.orphanDirs
  if (!Array.isArray(rawOrphanDirs) || rawOrphanDirs.some((entry) => typeof entry !== 'string')) {
    return fail('orphanDirs is missing or not an array of strings')
  }
  const orphanDirs = rawOrphanDirs.map((entry: string) => pathOps.toNative(entry))

  const summary = value.summary
  if (!isRecord(summary)) return fail('summary is missing or not an object')
  const registered = summary.registered
  if (typeof registered !== 'number') return fail('summary.registered is missing or not a number')
  const byStateRaw = summary.byState
  if (!isRecord(byStateRaw)) return fail('summary.byState is missing or not an object')
  const byState: Partial<Record<WorktreeState, number>> = {}
  for (const [key, count] of Object.entries(byStateRaw)) {
    if (!STATES.has(key) || typeof count !== 'number') {
      return fail(`summary.byState has an unrecognized entry '${key}'`)
    }
    byState[key as WorktreeState] = count
  }

  return {
    ok: true,
    mainRoot: pathOps.toNative(mainRoot),
    integrationRef,
    forcedActions: pathScope ? 'supported' : 'unsupported',
    worktrees,
    orphanDirs,
    registered,
    byState,
  }
}

type ParsedReclaim =
  | { readonly ok: true; readonly removed: number; readonly results: readonly ReclaimedWorktree[] }
  | { readonly ok: false; readonly message: string }

// Parses `reclaim --json`'s stdout, reusing parseReportPayload's shape plus
// each candidate's own removed/error/branchDeleted fields.
export function parseReclaimPayload(stdout: string, pathOps: PathOps): ParsedReclaim {
  const base = parseReportPayload(stdout, pathOps)
  if (!base.ok) return { ok: false, message: base.message }

  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return { ok: false, message: "the script's stdout was not valid JSON" }
  }
  if (!isRecord(value)) return { ok: false, message: "the script's stdout was not a JSON object" }
  const rawCandidates = value.candidates
  if (!Array.isArray(rawCandidates)) return { ok: false, message: 'candidates is missing or not an array' }

  const results: ReclaimedWorktree[] = []
  let removedCount = 0
  for (const [index, raw] of rawCandidates.entries()) {
    if (!isRecord(raw)) return { ok: false, message: `candidates[${index}] is not an object` }

    const removedFlag = raw.removed
    if (typeof removedFlag !== 'boolean') return { ok: false, message: `candidates[${index}].removed is missing or not a boolean` }

    const error = raw.error
    if (!stringOrNull(error)) return { ok: false, message: `candidates[${index}].error is not a string or null` }

    const branchDeleted = raw.branchDeleted
    if (!(branchDeleted === null || typeof branchDeleted === 'boolean')) {
      return { ok: false, message: `candidates[${index}].branchDeleted is not a boolean or null` }
    }

    const matched = base.worktrees[index]
    if (matched === undefined) return { ok: false, message: `candidates[${index}] has no matching parsed worktree` }

    const outcome: ReclaimedWorktree['outcome'] = removedFlag ? 'removed' : error !== null ? 'failed' : 'kept'
    if (outcome === 'removed') removedCount++

    results.push({
      path: matched.path,
      pathBasename: pathOps.basename(matched.path),
      issue: matched.issue,
      outcome,
      error,
      branchDeleted,
    })
  }

  return { ok: true, removed: removedCount, results }
}

const CAUSES: ReadonlySet<string> = new Set<PurgeCause>(['file-in-use', 'long-path', 'unknown'])

type ParsedPurge =
  | { readonly ok: true; readonly outcome: PurgeOutcome; readonly message: string | null; readonly cause: PurgeCause | null }
  | { readonly ok: false; readonly message: string }

// Parses `purge --orphan <path> --json`'s stdout, which this app only ever requests for one path.
export function parsePurgePayload(stdout: string): ParsedPurge {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return { ok: false, message: "the script's stdout was not valid JSON" }
  }
  if (!isRecord(value)) return { ok: false, message: "the script's stdout was not a JSON object" }

  const results = value.results
  if (!Array.isArray(results) || results.length !== 1) return { ok: false, message: 'results is missing or not a one-entry array' }
  const raw: unknown = results[0]
  if (!isRecord(raw)) return { ok: false, message: 'results[0] is not an object' }

  const { deleted, refused, error, cause } = raw
  if (typeof deleted !== 'boolean') return { ok: false, message: 'results[0].deleted is missing or not a boolean' }
  if (!stringOrNull(refused)) return { ok: false, message: 'results[0].refused is not a string or null' }
  if (!stringOrNull(error)) return { ok: false, message: 'results[0].error is not a string or null' }
  if (!(cause === null || (typeof cause === 'string' && CAUSES.has(cause)))) {
    return { ok: false, message: `results[0].cause is ${JSON.stringify(cause)}, not a known cause or null` }
  }

  if (deleted) return { ok: true, outcome: 'deleted', message: null, cause: null }
  if (refused !== null) return { ok: true, outcome: 'refused', message: refused, cause: null }
  return { ok: true, outcome: 'failed', message: error ?? 'the script reported no error text', cause: cause as PurgeCause | null }
}
