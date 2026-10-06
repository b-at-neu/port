// Pure: classifies a parsed `gh api graphql` response body into usable/partial/blind. Never
// reads a non-zero exit code as "no data" — only an unparsable body is blind.

/** `body` is the parsed `{ data, errors }` GraphQL envelope, or `null` if unparsable. Returns
 *  `blind` (no data), `partial` (errors present, only `errors[].path` aliases unavailable), or `usable`. */
export function classifyEnvelope(body: any): { kind: string; unavailable: string[] } {
  if (!body || body.data == null) return { kind: 'blind', unavailable: [] };

  const errors = Array.isArray(body.errors) ? body.errors : [];
  if (errors.length === 0) return { kind: 'usable', unavailable: [] };

  // GraphQL error paths are `["repository", "<alias>", ...]` — the alias name is always the second element.
  const unavailable: string[] = [
    ...new Set<string>(
      errors
        .map((e: any) => (Array.isArray(e.path) && e.path.length >= 2 ? e.path[1] : null))
        .filter((p: unknown): p is string => typeof p === 'string'),
    ),
  ];
  return { kind: 'partial', unavailable };
}

/** A connection is truncated when its `totalCount` exceeds its returned `nodes` length.
 *  Returns the list of alias names whose connection under-returned. */
export function truncatedAliases(repository: any): string[] {
  if (!repository) return [];
  const hits: string[] = [];
  for (const [alias, value] of Object.entries<any>(repository)) {
    if (value && typeof value === 'object' && Array.isArray(value.nodes) && typeof value.totalCount === 'number') {
      if (value.totalCount > value.nodes.length) hits.push(alias);
    }
  }
  return hits;
}
