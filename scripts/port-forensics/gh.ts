// The orphan assertion's one GitHub read: which issues and pull requests carry an in-flight
// label. Reuses the tick engine's `runGraphql` rather than spawning a second `gh` process.
import { runGraphql } from '../port-tick/gh.ts';
import { LABEL_DEFAULTS } from '../port-tick/config.ts';

// The five in-flight labels an orphan can be reported against — gate/trigger/terminal labels never mean "an agent is working right now".
export const IN_FLIGHT_LABEL_KEYS = ['planning', 'inProgress', 'reviewing', 'revising', 'refreshing'];

/** One GraphQL query, aliased per in-flight label key, each a `search(..., type: ISSUE)`
 *  scoped to this repository and that label. No `--jq`: `reduceInFlightItems` parses it. */
export function buildInFlightQuery({ owner, name, labels = LABEL_DEFAULTS }: { owner: string; name: string; labels?: Record<string, string> }): string {
  const repoQualifier = `repo:${owner}/${name}`;
  const parts = IN_FLIGHT_LABEL_KEYS.map((key) => {
    const labelName = labels[key] ?? (LABEL_DEFAULTS as Record<string, string>)[key];
    const searchQuery = `${repoQualifier} is:open label:${JSON.stringify(labelName)}`;
    return `${key}: search(query: ${JSON.stringify(searchQuery)}, type: ISSUE, first: 50) { nodes { __typename ... on Issue { number } ... on PullRequest { number } } }`;
  });
  return `query { ${parts.join(' ')} }`;
}

/** Reduces the GraphQL body to `[{ number, labelKey, label }]`. Only the aliases actually
 *  present in a partial-error response are read — a missing one contributes nothing, never a thrown error. */
export function reduceInFlightItems(body: any, labels: Record<string, string> = LABEL_DEFAULTS): any[] {
  const data = body?.data ?? {};
  const items: any[] = [];
  for (const key of IN_FLIGHT_LABEL_KEYS) {
    const nodes = data[key]?.nodes ?? [];
    for (const node of nodes) {
      if (typeof node?.number === 'number') items.push({ number: node.number, labelKey: key, label: labels[key] ?? (LABEL_DEFAULTS as Record<string, string>)[key] });
    }
  }
  return items;
}

/** The whole impure call: build, run, reduce. Never throws: a failed call reports `ok: false`
 *  so the orphan assertion degrades to "not computable" rather than crashing the whole report. */
export function fetchInFlightItems(cfg: any): any {
  const query = buildInFlightQuery(cfg);
  const res = runGraphql(query);
  if (!res.ok) return { ok: false, error: res.error ?? 'gh api graphql failed' };
  return { ok: true, items: reduceInFlightItems(res.body, cfg.labels) };
}
