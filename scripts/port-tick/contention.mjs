// Pure: the file-contention gate from plugins/port/docs/PIPELINE.md → "File
// contention" and plugins/port/skills/pipeline/SKILL.md → "File contention
// gate". Parses each plan's ` ```files ` block, builds the occupied set from
// in-flight items, holds a candidate whose claims overlap one in-flight
// item's non-shared claims at or above `overlapThreshold` (counted per
// in-flight item, never pooled), and orders survivors fewest-conflicts-first.

/** One claimed path per non-blank line: the first whitespace-delimited
 *  token, everything after is a human-readable reason and never parsed.
 *  Returns `null` when the plan has no ` ```files ` fence at all — the
 *  caller dispatches that plan unchecked, per "Fail-open on an unstructured
 *  plan". */
export function parseFilesBlock(planBody) {
  const m = /```files\n([\s\S]*?)```/.exec(planBody ?? '');
  if (!m) return null;
  const paths = [];
  for (const line of m[1].split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const path = trimmed.split(/\s+/)[0];
    if (path) paths.push(path);
  }
  return paths;
}

/** Whether claim `a` and claim `b` refer to overlapping paths — a trailing
 *  `/` on either side matches any path beneath it. */
function claimsOverlap(a, b) {
  const aDir = a.endsWith('/');
  const bDir = b.endsWith('/');
  if (aDir && bDir) return a === b || a.startsWith(b) || b.startsWith(a);
  if (aDir) return b === a.slice(0, -1) || b.startsWith(a);
  if (bDir) return a === b.slice(0, -1) || a.startsWith(b);
  return a === b;
}

/** Removes any path in `paths` that overlaps a `concurrency.sharedFiles`
 *  entry — a shared path is still claimed by its own plan, only never
 *  contended, in either direction. */
export function excludeShared(paths, sharedFiles) {
  return paths.filter((p) => !sharedFiles.some((s) => claimsOverlap(p, s)));
}

/** Count of `candidatePaths` that overlap at least one of `otherPaths`. */
export function overlapDepth(candidatePaths, otherPaths) {
  return candidatePaths.filter((cp) => otherPaths.some((op) => claimsOverlap(cp, op))).length;
}

/** Checks one candidate's non-shared claimed paths against every entry in
 *  `occupiedSet` (`[{ item, label, paths }]`), holding on the first in-flight
 *  item whose own non-shared claims overlap at or above `threshold` — never
 *  pooled across in-flight items. Returns `{ held: false }` or `{ held:
 *  true, blocker, blockerLabel, depth, contendedPaths }`. */
export function contentionForCandidate(candidatePaths, occupiedSet, sharedFiles, threshold) {
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

/** Orders and gates every structured candidate (`[{ item, paths }]`,
 *  unstructured ones already routed to `unchecked` by the caller) against the
 *  initial `occupiedSet`. Survivors are sorted ascending by how many *other
 *  survivors* they overlap at or above `threshold`, then dispatched in that
 *  order, growing the occupied set as each one dispatches — so a later
 *  survivor that now overlaps an earlier one's freshly-claimed files is held
 *  this same pass, never dispatched. Returns `{ dispatch: [...items], held:
 *  [{ item, blocker, blockerLabel, depth, contendedPaths }] }`. */
export function gateCandidates(candidates, occupiedSet, sharedFiles, threshold) {
  const held = [];
  const survivors = [];
  for (const c of candidates) {
    const result = contentionForCandidate(c.paths, occupiedSet, sharedFiles, threshold);
    if (result.held) held.push({ item: c.item, ...result });
    else survivors.push(c);
  }

  const conflictCount = (c) =>
    survivors.filter((other) => other.item !== c.item).filter((other) => {
      const a = excludeShared(c.paths, sharedFiles);
      const b = excludeShared(other.paths, sharedFiles);
      return overlapDepth(a, b) >= threshold;
    }).length;

  const ordered = [...survivors].sort((a, b) => conflictCount(a) - conflictCount(b));

  const dispatch = [];
  let growing = occupiedSet;
  for (const c of ordered) {
    const result = contentionForCandidate(c.paths, growing, sharedFiles, threshold);
    if (result.held) {
      held.push({ item: c.item, ...result });
      continue;
    }
    dispatch.push(c.item);
    growing = [...growing, { item: c.item, label: 'dispatching', paths: c.paths }];
  }

  return { dispatch, held };
}
