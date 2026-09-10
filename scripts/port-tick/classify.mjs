// Pure: ownership partition against the viewer, and the SESSION REQUIRED
// marker-slot read. Per plugins/port/docs/PIPELINE.md → "Multi-operator
// partitioning" and "Session-required tickets" → "Detection".

/** Splits `nodes` (one alias's issues or pull requests) into `mine` (acted
 *  on), `others` (another operator's — never acted on), and `unowned` (no
 *  assignee — reported, never acted on). "An item whose assignees do not
 *  include the viewer is never acted on, only reported." */
export function partitionOwnership(nodes, viewerLogin) {
  const mine = [];
  const others = [];
  const unowned = [];
  for (const n of nodes ?? []) {
    const logins = (n.assignees?.nodes ?? []).map((a) => a.login);
    if (logins.length === 0) unowned.push(n);
    else if (logins.includes(viewerLogin)) mine.push(n);
    else others.push(n);
  }
  return { mine, others, unowned };
}

const MARKER_RE = /^> \*\*SESSION REQUIRED:\*\* (.+)$/;

/** The first non-empty line after `heading` (a literal substring), or `null`
 *  when the heading is absent or nothing non-empty follows it. Never a
 *  body-wide substring search — "slot plus form", per Detection. */
function firstNonEmptyAfter(body, heading) {
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
export function issueSessionRequiredReason(body) {
  const line = firstNonEmptyAfter(body, '## Implementation Plan');
  const m = line ? MARKER_RE.exec(line) : null;
  return m ? m[1] : null;
}

/** Returns the reason string when the pull request body carries the marker
 *  at its slot (the first non-empty line after `Closes #N`), else `null`. */
export function prSessionRequiredReason(body) {
  if (!body) return null;
  const idx = body.search(/Closes #\d+/);
  if (idx === -1) return null;
  const lineEnd = body.indexOf('\n', idx);
  const after = lineEnd === -1 ? '' : body.slice(lineEnd + 1);
  for (const line of after.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') {
      const m = MARKER_RE.exec(trimmed);
      return m ? m[1] : null;
    }
  }
  return null;
}
