// Validates `templates/worktrees.mjs report --json`'s stdout field by field
// into `ParsedWorktree[]` plus `orphanDirs`/`mainRoot`/`integrationRef`/
// `registered`/`byState`. A missing field, a non-array `candidates`, or a
// `state` outside `WORKTREE_STATES` fails the whole payload as
// `report-unparseable`, naming the field — never a partial list (ENGINEERING
// §4: an absent signal is never read as a passing one).
import type { PathOps } from '../platform'
import type { CorrelationRung } from '../../shared/local/types'
import type { WorktreeState } from '../../shared/reclaimer/types'
import { WORKTREE_STATES } from '../../shared/reclaimer/types'

const RUNGS: ReadonlySet<string> = new Set<CorrelationRung>(['upstream-branch', 'branch-name', 'directory-basename', 'head-subject'])
const STATES: ReadonlySet<string> = new Set<string>(WORKTREE_STATES)

export interface ParsedWorktree {
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
}

export type ParsedReport =
  | {
      readonly ok: true
      readonly mainRoot: string
      readonly integrationRef: string
      readonly worktrees: readonly ParsedWorktree[]
      readonly orphanDirs: readonly string[]
      readonly registered: number
      readonly byState: Readonly<Partial<Record<WorktreeState, number>>>
    }
  | { readonly ok: false; readonly message: string }

function fail(message: string): ParsedReport {
  return { ok: false, message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function parseCandidate(raw: unknown, index: number, pathOps: PathOps): ParsedWorktree | string {
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
  }
}

/** Parses the script's `--json` stdout. Every path is run through
 *  `pathOps.toNative` — the script emits `C:/Users/…`-style paths even on
 *  Windows, and #77's join (in `report.ts`) compares by `pathOps.pathKey`,
 *  which requires the same native form on both sides. */
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

  const worktrees: ParsedWorktree[] = []
  for (const [index, raw] of rawCandidates.entries()) {
    const parsed = parseCandidate(raw, index, pathOps)
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

  return { ok: true, mainRoot: pathOps.toNative(mainRoot), integrationRef, worktrees, orphanDirs, registered, byState }
}
