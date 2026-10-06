// Pure: ownership partition against the viewer, and the SESSION REQUIRED marker-slot read.
// The app imports `partitionOwnership` directly: no relative import for that export, a leaf.

export interface OwnershipPartition<T> {
  readonly mine: readonly T[];
  readonly others: readonly T[];
  readonly unowned: readonly T[];
}

/** Splits `items` into `mine` (acted on), `others` (another operator's, never acted on), and
 *  `unowned` (no assignee, reported, never acted on). Returns the caller's own nodes, never a reshaped copy. */
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

/** The first non-empty line after `heading`, or `null` when absent or nothing follows. Never a body-wide substring search. */
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

/** The reason string when the issue's plan block carries the marker at its slot, else `null`. */
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
