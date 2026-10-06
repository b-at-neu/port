// Pure: the file-contention gate. Parses each plan's files block, gates
// candidates against the occupied set. A leaf module — no relative import.

export interface ClaimedItem {
  readonly item: number;
  readonly paths: readonly string[];
}

export interface OccupiedEntry {
  readonly item: number;
  readonly label: string;
  readonly paths: readonly string[];
}

export type ContentionResult =
  | { readonly held: false }
  | {
      readonly held: true;
      readonly blocker: number;
      readonly blockerLabel: string;
      readonly depth: number;
      readonly contendedPaths: readonly string[];
    };

export interface GateHeld {
  readonly item: number;
  readonly blocker: number;
  readonly blockerLabel: string;
  readonly depth: number;
  readonly contendedPaths: readonly string[];
}

export interface GateResult {
  readonly dispatch: readonly number[];
  readonly held: readonly GateHeld[];
}

/** One claimed path per non-blank line: the first token, rest is a never-parsed reason.
 *  `null` when the plan has no ` ```files ` fence — the caller dispatches it unchecked. */
export function parseFilesBlock(planBody: string | null | undefined): readonly string[] | null {
  const m = /```files\n([\s\S]*?)```/.exec(planBody ?? '');
  if (!m) return null;
  const paths: string[] = [];
  for (const line of (m[1] ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const path = trimmed.split(/\s+/)[0];
    if (path) paths.push(path);
  }
  return paths;
}

/** Whether claim `a` and claim `b` refer to overlapping paths — a trailing
 *  `/` on either side matches any path beneath it. */
function claimsOverlap(a: string, b: string): boolean {
  const aDir = a.endsWith('/');
  const bDir = b.endsWith('/');
  if (aDir && bDir) return a === b || a.startsWith(b) || b.startsWith(a);
  if (aDir) return b === a.slice(0, -1) || b.startsWith(a);
  if (bDir) return a === b.slice(0, -1) || a.startsWith(b);
  return a === b;
}

/** Removes any path that overlaps a `concurrency.sharedFiles` entry — shared is still claimed, never contended. */
export function excludeShared(paths: readonly string[], sharedFiles: readonly string[]): readonly string[] {
  return paths.filter((p) => !sharedFiles.some((s) => claimsOverlap(p, s)));
}

/** Count of `candidatePaths` that overlap at least one of `otherPaths`. */
export function overlapDepth(candidatePaths: readonly string[], otherPaths: readonly string[]): number {
  return candidatePaths.filter((cp) => otherPaths.some((op) => claimsOverlap(cp, op))).length;
}

/** Holds on the first in-flight item whose non-shared claims overlap at or above `threshold`
 *  — never pooled across in-flight items. */
export function contentionForCandidate(
  candidatePaths: readonly string[],
  occupiedSet: readonly OccupiedEntry[],
  sharedFiles: readonly string[],
  threshold: number,
): ContentionResult {
  const nonShared = excludeShared(candidatePaths, sharedFiles);
  for (const occ of occupiedSet) {
    const occNonShared = excludeShared(occ.paths, sharedFiles);
    const depth = overlapDepth(nonShared, occNonShared);
    if (depth >= threshold) {
      const contendedPaths = nonShared.filter((cp) => occNonShared.some((op) => claimsOverlap(cp, op)));
      return { held: true, blocker: occ.item, blockerLabel: occ.label, depth, contendedPaths };
    }
  }
  return { held: false };
}

/** Orders and gates every structured candidate against the initial `occupiedSet`. Survivors
 *  sort ascending by overlap count, dispatched in that order, growing the occupied set as each dispatches. */
export function gateCandidates(
  candidates: readonly ClaimedItem[],
  occupiedSet: readonly OccupiedEntry[],
  sharedFiles: readonly string[],
  threshold: number,
): GateResult {
  const held: GateHeld[] = [];
  const survivors: ClaimedItem[] = [];
  for (const c of candidates) {
    const result = contentionForCandidate(c.paths, occupiedSet, sharedFiles, threshold);
    if (result.held) held.push({ item: c.item, blocker: result.blocker, blockerLabel: result.blockerLabel, depth: result.depth, contendedPaths: result.contendedPaths });
    else survivors.push(c);
  }

  const conflictCount = (c: ClaimedItem): number =>
    survivors
      .filter((other) => other.item !== c.item)
      .filter((other) => {
        const a = excludeShared(c.paths, sharedFiles);
        const b = excludeShared(other.paths, sharedFiles);
        return overlapDepth(a, b) >= threshold;
      }).length;

  const ordered = [...survivors].sort((a, b) => conflictCount(a) - conflictCount(b));

  const dispatch: number[] = [];
  let growing = occupiedSet;
  for (const c of ordered) {
    const result = contentionForCandidate(c.paths, growing, sharedFiles, threshold);
    if (result.held) {
      held.push({ item: c.item, blocker: result.blocker, blockerLabel: result.blockerLabel, depth: result.depth, contendedPaths: result.contendedPaths });
      continue;
    }
    dispatch.push(c.item);
    growing = [...growing, { item: c.item, label: 'dispatching', paths: c.paths }];
  }

  return { dispatch, held };
}
