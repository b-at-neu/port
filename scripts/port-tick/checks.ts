// Pure: the statusCheckRollup reduction contract. Reduces to the latest entry per check name,
// then reads the verdict — never trusting `gh pr checks`'s exit code, never reading an empty rollup as green.

/** The union of a CheckRun's and a StatusContext's own fields this module reads — every
 *  field optional, since the two GraphQL types carry different subsets. */
export interface CheckContext {
  readonly __typename?: string | null;
  readonly name?: string | null;
  readonly context?: string | null;
  readonly status?: string | null;
  readonly state?: string | null;
  readonly conclusion?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly createdAt?: string | null;
  readonly url?: string | null;
}

const GREEN = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** `(.name // .context)` — the field each carries the check's identity under. */
function nameOf(c: CheckContext): string | null {
  return c.name ?? c.context ?? null;
}

/** The sortable moment a context reports itself at: `startedAt`, falling back to
 *  `completedAt`, then `createdAt` — whichever this union member carries. */
function timeOf(c: CheckContext): string | null {
  return c.startedAt ?? c.completedAt ?? c.createdAt ?? null;
}

/** Reduces a rollup's `contexts.nodes` to the latest entry per check name by `timeOf` — the
 *  approval gate re-runs on every labeled event, so one pull request can carry several entries for the same name. */
export function reduceRollup(contexts: readonly CheckContext[] | undefined): readonly CheckContext[] {
  const latest = new Map<string, CheckContext>();
  for (const c of contexts ?? []) {
    const name = nameOf(c);
    if (name === null) continue;
    const t = timeOf(c);
    const prior = latest.get(name);
    if (prior === undefined || (t ?? '') > (timeOf(prior) ?? '')) latest.set(name, c);
  }
  return [...latest.values()];
}

/** Concluded is `status == 'COMPLETED'` for a CheckRun, or `state != 'PENDING'` for a StatusContext. */
export function isConcluded(entry: CheckContext): boolean {
  if (entry.__typename === 'StatusContext') return entry.state !== 'PENDING';
  return entry.status === 'COMPLETED';
}

/** `(.conclusion // .state)` — whichever this entry carries. */
export function conclusionOf(entry: CheckContext): string | null {
  return entry.conclusion ?? entry.state ?? null;
}

/** A single check's disposition: `blocking` (default — a red conclusion forms a finding and
 *  blocks) or `infrastructure` (reported, no finding, never blocks). `source` names where it came from. */
export interface Disposition {
  readonly disposition: 'blocking' | 'infrastructure';
  readonly source: 'approval-gate' | 'CLAUDE.md';
}

export interface RollupVerdict {
  readonly pending: boolean;
  readonly zeroEvidence?: boolean;
  readonly red: readonly { readonly name: string | null; readonly conclusion: string | null }[];
  readonly green: readonly (string | null)[];
  readonly excused: readonly { readonly name: string | null; readonly conclusion: string | null; readonly source: Disposition['source'] }[];
  readonly unmatched: readonly string[];
}

/** Reduces `contexts` to a verdict against `dispositions`. An empty/absent rollup is pending,
 *  never green; zero evidence (every entry excused) is likewise pending, never green. */
export function rollupVerdict(contexts: readonly CheckContext[] | null | undefined, dispositions: Readonly<Record<string, Disposition>> = {}): RollupVerdict {
  if (contexts === null || contexts === undefined || contexts.length === 0) return { pending: true, red: [], green: [], excused: [], unmatched: [] };

  const reduced = reduceRollup(contexts);
  const isExcused = (e: CheckContext): boolean => dispositions[nameOf(e) ?? '']?.disposition === 'infrastructure';

  const blocking = reduced.filter((e) => !isExcused(e));
  const excused = reduced
    .filter((e) => isExcused(e))
    .map((e) => {
      const name = nameOf(e);
      const source = dispositions[name ?? '']?.source ?? 'approval-gate';
      return { name, conclusion: conclusionOf(e), source };
    });

  const reducedNames = new Set(reduced.map((e) => nameOf(e)));
  const unmatched = Object.entries(dispositions)
    .filter(([name, d]) => d.disposition === 'infrastructure' && !reducedNames.has(name))
    .map(([name]) => name);

  const pending = blocking.some((e) => !isConcluded(e));
  const red = blocking.filter((e) => isConcluded(e) && !GREEN.has(conclusionOf(e) ?? '')).map((e) => ({ name: nameOf(e), conclusion: conclusionOf(e) }));
  const green = blocking.filter((e) => isConcluded(e) && GREEN.has(conclusionOf(e) ?? '')).map((e) => nameOf(e));

  if (blocking.length === 0 && excused.length > 0) {
    return { pending: true, zeroEvidence: true, red: [], green: [], excused, unmatched };
  }

  return { pending: pending && red.length === 0, red, green, excused, unmatched };
}
