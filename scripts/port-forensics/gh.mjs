// The orphan assertion's one GitHub read (#123): which issues and pull
// requests currently carry an in-flight label. Reuses the tick engine's own
// `runGraphql` (scripts/port-tick/gh.mjs) rather than spawning a second `gh`
// child process — that module's whole contract is already "one read-only
// `gh api graphql` call, explicit argv, no shell:true" (docs/ENGINEERING.md
// §1), so this file only builds the query and reduces the response. Label
// names are resolved from `.claude/port.config.json` (falling back to
// PIPELINE.md's default table via `scripts/port-tick/config.mjs`'s own
// `LABEL_DEFAULTS`), never a literal.
import { runGraphql } from '../port-tick/gh.mjs';
import { LABEL_DEFAULTS } from '../port-tick/config.mjs';

// The five in-flight labels an orphan can be reported against — the
// pipeline's own gate/trigger/terminal labels never mean "an agent is
// working right now", so they are deliberately excluded.
export const IN_FLIGHT_LABEL_KEYS = ['planning', 'inProgress', 'reviewing', 'revising', 'refreshing'];

/** One GraphQL query, aliased per in-flight label key, each a `search(...,
 *  type: ISSUE)` scoped to this repository and that label — deliberately
 *  `search`, not `issue(...)`, because an in-flight item's number is not
 *  known ahead of the call. No `--jq`: the whole response is parsed by
 *  `reduceInFlightItems` below. */
export function buildInFlightQuery({ owner, name, labels = LABEL_DEFAULTS }) {
  const repoQualifier = `repo:${owner}/${name}`;
  const parts = IN_FLIGHT_LABEL_KEYS.map((key) => {
    const labelName = labels[key] ?? LABEL_DEFAULTS[key];
    const searchQuery = `${repoQualifier} is:open label:${JSON.stringify(labelName)}`;
    return `${key}: search(query: ${JSON.stringify(searchQuery)}, type: ISSUE, first: 50) { nodes { __typename ... on Issue { number } ... on PullRequest { number } } }`;
  });
  return `query { ${parts.join(' ')} }`;
}

/** Reduces the GraphQL body to `[{ number, labelKey, label }]`. Only the
 *  aliases actually present in a partial-error response are read — an alias
 *  named in `errors[].path` and therefore missing from `data` contributes
 *  nothing, never a thrown error (docs/ENGINEERING.md §4). */
export function reduceInFlightItems(body, labels = LABEL_DEFAULTS) {
  const data = body?.data ?? {};
  const items = [];
  for (const key of IN_FLIGHT_LABEL_KEYS) {
    const nodes = data[key]?.nodes ?? [];
    for (const node of nodes) {
      if (typeof node?.number === 'number') items.push({ number: node.number, labelKey: key, label: labels[key] ?? LABEL_DEFAULTS[key] });
    }
  }
  return items;
}

/** The whole impure call: build, run, reduce. `cfg` is the already-loaded
 *  `.claude/port.config.json` shape `scripts/port-tick/config.mjs`'s
 *  `loadConfig` returns (`owner`, `name`, `labels`). Never throws: a failed
 *  call reports `ok: false` so the orphan assertion degrades to "not
 *  computable" rather than crashing the whole report. */
export function fetchInFlightItems(cfg) {
  const query = buildInFlightQuery(cfg);
  const res = runGraphql(query);
  if (!res.ok) return { ok: false, error: res.error ?? 'gh api graphql failed' };
  return { ok: true, items: reduceInFlightItems(res.body, cfg.labels) };
}
