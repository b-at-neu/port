// Pure: ownership partition against the viewer, and the SESSION REQUIRED
// marker-slot read. Per plugins/port/docs/PIPELINE.md → "Multi-operator
// partitioning" and "Session-required tickets" → "Detection". The app
// imports `partitionOwnership` directly (docs/ENGINEERING.md §1): no
// relative import for that export, a leaf.

export interface OwnershipPartition<T> {
  readonly mine: readonly T[];
  readonly others: readonly T[];
  readonly unowned: readonly T[];
}

/** Splits `items` (one alias's issues or pull requests, or any other
 *  assignable node) into `mine` (acted on), `others` (another operator's —
 *  never acted on), and `unowned` (no assignee — reported, never acted on).
 *  "An item whose assignees do not include the viewer is never acted on,
 *  only reported." `assigneesOf` reads each item's own assignee logins —
 *  the caller's raw GraphQL nodes for the cockpit (`wire.ts`'s
 *  `assigneeLoginsOf`), the app's already-flattened `assignees: string[]`
 *  for apps/desktop — so this returns the caller's own nodes, never a
 *  reshaped copy. */
export function partitionOwnership<T>(items: readonly T[] | undefined, viewerLogin: string | null, assigneesOf: (item: T) => readonly string[]): OwnershipPartition<T> {
  const mine: T[] = [];
  const others: T[] = [];
  const unowned: T[] = [];
  for (const item of items ?? []) {
    const logins = assigneesOf(item);
    if (logins.length === 0) unowned.push(item);
    else if (viewerLogin !== null && logins.includes(viewerLogin)) mine.push(item);
    else others.push(item);
  }
  return { mine, others, unowned };
}

const MARKER_RE = /^> \*\*SESSION REQUIRED:\*\* (.+)$/;

/** The first non-empty line after `heading` (a literal substring), or `null`
 *  when the heading is absent or nothing non-empty follows it. Never a
 *  body-wide substring search — "slot plus form", per Detection. */
function firstNonEmptyAfter(body: string | null | undefined, heading: string): string | null {
  if (!body) return null;
  const idx = body.indexOf(heading);
  if (idx === -1) return null;
  const after = body.slice(idx + heading.length);
  for (const line of after.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return null;
}

/** Returns the reason string when the issue's plan block carries the marker
 *  at its slot (the first non-empty line directly under `## Implementation
 *  Plan`), else `null`. */
export function issueSessionRequiredReason(body: string | null | undefined): string | null {
  const line = firstNonEmptyAfter(body, '## Implementation Plan');
  const m = line ? MARKER_RE.exec(line) : null;
  return m ? m[1] ?? null : null;
}

/** Returns the reason string when the pull request body carries the marker
 *  at its slot (the first non-empty line after `Closes #N`), else `null`. */
export function prSessionRequiredReason(body: string | null | undefined): string | null {
  if (!body) return null;
  const idx = body.search(/Closes #\d+/);
  if (idx === -1) return null;
  const lineEnd = body.indexOf('\n', idx);
  const after = lineEnd === -1 ? '' : body.slice(lineEnd + 1);
  for (const line of after.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') {
      const m = MARKER_RE.exec(trimmed);
      return m ? m[1] ?? null : null;
    }
  }
  return null;
}
