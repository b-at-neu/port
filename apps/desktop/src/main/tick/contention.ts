// Pure: the file-contention gate from plugins/port/docs/PIPELINE.md → "File
// contention" and plugins/port/skills/pipeline/SKILL.md → "File contention
// gate", ported verbatim from scripts/port-tick/contention.mjs's own
// exports — pinned against that file, both directions, by
// scripts/checks/desktop-tick.mjs's dynamic import, the same idiom
// liveness.ts already uses for RETRY_TRIGGER. Typed against local
// ClaimedItem/OccupiedEntry/GateResult shapes; no `node:` import, no
// `../platform` — `main/tick/` is a pure decision layer, it never reaches
// I/O (the same rail `scripts/checks/desktop-tick.mjs` already pins for this
// directory).

/** One structured candidate's own item number and claimed paths — the
 *  engine's own `{ item, paths }` shape. */
export interface ClaimedItem {
  readonly item: number
  readonly paths: readonly string[]
}

/** One entry in the occupied set — an in-flight item's own claimed paths,
 *  plus the stage label it is occupying under, carried through only for
 *  the held detail's own copy. */
export interface OccupiedEntry {
  readonly item: number
  readonly label: string
  readonly paths: readonly string[]
}

export type ContentionResult =
  | { readonly held: false }
  | {
      readonly held: true
      readonly blocker: number
      readonly blockerLabel: string
      readonly depth: number
      readonly contendedPaths: readonly string[]
    }

export interface GateHeld {
  readonly item: number
  readonly blocker: number
  readonly blockerLabel: string
  readonly depth: number
  readonly contendedPaths: readonly string[]
}

export interface GateResult {
  readonly dispatch: readonly number[]
  readonly held: readonly GateHeld[]
}

/** One claimed path per non-blank line: the first whitespace-delimited
 *  token, everything after is a human-readable reason and never parsed.
 *  Returns `null` when the plan has no ` ```files ` fence at all — the
 *  caller dispatches that plan unchecked, per "Fail-open on an unstructured
 *  plan". */
export function parseFilesBlock(planBody: string | null | undefined): readonly string[] | null {
  const m = /```files\n([\s\S]*?)```/.exec(planBody ?? '')
  if (!m) return null
  const paths: string[] = []
  for (const line of (m[1] ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const path = trimmed.split(/\s+/)[0]
    if (path) paths.push(path)
  }
  return paths
}

/** Whether claim `a` and claim `b` refer to overlapping paths — a trailing
 *  `/` on either side matches any path beneath it. */
function claimsOverlap(a: string, b: string): boolean {
  const aDir = a.endsWith('/')
  const bDir = b.endsWith('/')
  if (aDir && bDir) return a === b || a.startsWith(b) || b.startsWith(a)
  if (aDir) return b === a.slice(0, -1) || b.startsWith(a)
  if (bDir) return a === b.slice(0, -1) || a.startsWith(b)
  return a === b
}

/** Removes any path in `paths` that overlaps a `concurrency.sharedFiles`
 *  entry — a shared path is still claimed by its own plan, only never
 *  contended, in either direction. */
export function excludeShared(paths: readonly string[], sharedFiles: readonly string[]): readonly string[] {
  return paths.filter((p) => !sharedFiles.some((s) => claimsOverlap(p, s)))
}

/** Count of `candidatePaths` that overlap at least one of `otherPaths`. */
export function overlapDepth(candidatePaths: readonly string[], otherPaths: readonly string[]): number {
  return candidatePaths.filter((cp) => otherPaths.some((op) => claimsOverlap(cp, op))).length
}

/** Checks one candidate's non-shared claimed paths against every entry in
 *  `occupiedSet`, holding on the first in-flight item whose own non-shared
 *  claims overlap at or above `threshold` — never pooled across in-flight
 *  items. */
export function contentionForCandidate(
  candidatePaths: readonly string[],
  occupiedSet: readonly OccupiedEntry[],
  sharedFiles: readonly string[],
  threshold: number,
): ContentionResult {
  const nonShared = excludeShared(candidatePaths, sharedFiles)
  for (const occ of occupiedSet) {
    const occNonShared = excludeShared(occ.paths, sharedFiles)
    const depth = overlapDepth(nonShared, occNonShared)
    if (depth >= threshold) {
      const contendedPaths = nonShared.filter((cp) => occNonShared.some((op) => claimsOverlap(cp, op)))
      return { held: true, blocker: occ.item, blockerLabel: occ.label, depth, contendedPaths }
    }
  }
  return { held: false }
}

/** Orders and gates every structured candidate against the initial
 *  `occupiedSet`. Survivors are sorted ascending by how many *other
 *  survivors* they overlap at or above `threshold`, then dispatched in that
 *  order, growing the occupied set as each one dispatches — so a later
 *  survivor that now overlaps an earlier one's freshly-claimed files is held
 *  this same pass, never dispatched. */
export function gateCandidates(
  candidates: readonly ClaimedItem[],
  occupiedSet: readonly OccupiedEntry[],
  sharedFiles: readonly string[],
  threshold: number,
): GateResult {
  const held: GateHeld[] = []
  const survivors: ClaimedItem[] = []
  for (const c of candidates) {
    const result = contentionForCandidate(c.paths, occupiedSet, sharedFiles, threshold)
    if (result.held) held.push({ item: c.item, blocker: result.blocker, blockerLabel: result.blockerLabel, depth: result.depth, contendedPaths: result.contendedPaths })
    else survivors.push(c)
  }

  const conflictCount = (c: ClaimedItem): number =>
    survivors
      .filter((other) => other.item !== c.item)
      .filter((other) => {
        const a = excludeShared(c.paths, sharedFiles)
        const b = excludeShared(other.paths, sharedFiles)
        return overlapDepth(a, b) >= threshold
      }).length

  const ordered = [...survivors].sort((a, b) => conflictCount(a) - conflictCount(b))

  const dispatch: number[] = []
  let growing = occupiedSet
  for (const c of ordered) {
    const result = contentionForCandidate(c.paths, growing, sharedFiles, threshold)
    if (result.held) {
      held.push({ item: c.item, blocker: result.blocker, blockerLabel: result.blockerLabel, depth: result.depth, contendedPaths: result.contendedPaths })
      continue
    }
    dispatch.push(c.item)
    growing = [...growing, { item: c.item, label: 'dispatching', paths: c.paths }]
  }

  return { dispatch, held }
}
