// Pure: classifies a parsed `gh api graphql` response body into usable /
// partial / blind, per plugins/port/docs/PIPELINE.md → "The tick's cost and
// clock" and ENGINEERING.md §4's fail-closed-on-actions rule. Never reads a
// non-zero exit code as "no data" — only the caller (gh.mjs) failing to
// parse any JSON at all is blind.

/** `body` is the parsed `{ data, errors }` GraphQL envelope, or `null` when
 *  `gh.mjs` could not parse a body at all. Returns:
 *  - `{ kind: 'blind' }` — no `data` at all, or no body was parsable.
 *  - `{ kind: 'partial', unavailable: [...aliasNames] }` — `errors` present
 *    but `data` still usable; only the aliases named in `errors[].path` are
 *    unavailable, every other alias is trustworthy.
 *  - `{ kind: 'usable', unavailable: [] }` — a clean response. */
export function classifyEnvelope(body) {
  if (!body || body.data == null) return { kind: 'blind', unavailable: [] };

  const errors = Array.isArray(body.errors) ? body.errors : [];
  if (errors.length === 0) return { kind: 'usable', unavailable: [] };

  // GraphQL error paths are `["repository", "<alias>", ...]` for a field
  // under the one `repository(...)` selection this engine's query always
  // uses — the alias name is always the second element.
  const unavailable = [
    ...new Set(
      errors
        .map((e) => (Array.isArray(e.path) && e.path.length >= 2 ? e.path[1] : null))
        .filter((p) => typeof p === 'string'),
    ),
  ];
  return { kind: 'partial', unavailable };
}

/** A connection is truncated when its `totalCount` exceeds its returned
 *  `nodes` length — "act on what came back, never report the set as empty."
 *  `data` is the `repository` object; returns the list of alias names whose
 *  connection under-returned. */
export function truncatedAliases(repository) {
  if (!repository) return [];
  const hits = [];
  for (const [alias, value] of Object.entries(repository)) {
    if (value && typeof value === 'object' && Array.isArray(value.nodes) && typeof value.totalCount === 'number') {
      if (value.totalCount > value.nodes.length) hits.push(alias);
    }
  }
  return hits;
}
