// Pure: the statusCheckRollup reduction contract from
// plugins/port/docs/PIPELINE.md → "Check evidence". Reduces to the latest
// entry per check name, then reads the verdict — never trusting `gh pr
// checks`'s exit code, and never reading an empty rollup as green.
const GREEN = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** `(.name // .context)` — the field a CheckRun and a StatusContext each
 *  carry the check's identity under. */
const nameOf = (c: any): string | null => c.name ?? c.context ?? null;

/** The sortable moment a context reports itself at: `startedAt` for a
 *  CheckRun, falling back to `completedAt`, then a StatusContext's
 *  `createdAt` — whichever this union member actually carries. */
const timeOf = (c: any): string | null => c.startedAt ?? c.completedAt ?? c.createdAt ?? null;

/** Reduces a rollup's `contexts.nodes` to the latest entry per check name by
 *  `timeOf`, since the approval gate alone re-runs on every labeled event and
 *  a pull request that has been through a few label changes can carry
 *  several entries for the same name. */
export function reduceRollup(contexts: any[] | undefined): any[] {
  const latest = new Map<string, any>();
  for (const c of contexts ?? []) {
    const name = nameOf(c);
    if (!name) continue;
    const t = timeOf(c);
    const prior = latest.get(name);
    if (!prior || (t ?? '') > (prior.t ?? '')) latest.set(name, { ...c, t });
  }
  return [...latest.values()];
}

/** Concluded is `status == 'COMPLETED'` for a CheckRun, or `state !=
 *  'PENDING'` for a StatusContext. */
export function isConcluded(entry: any): boolean {
  if (entry.__typename === 'StatusContext') return entry.state !== 'PENDING';
  return entry.status === 'COMPLETED';
}

/** `(.conclusion // .state)` — CheckRun's conclusion, or a StatusContext's
 *  state, whichever this entry carries. */
export function conclusionOf(entry: any): string | null {
  return entry.conclusion ?? entry.state ?? null;
}

/** A single check's disposition (#246, generalizing the one derived
 *  approval-gate carve-out into a map): `blocking` (the default — a red
 *  conclusion forms a finding and blocks) or `infrastructure` (red is
 *  reported, forms no finding, never blocks). `source` names where the
 *  disposition came from, since an excused check is always listed with it. */
export interface Disposition {
  disposition: 'blocking' | 'infrastructure';
  source: 'approval-gate' | 'CLAUDE.md';
}

/** Reduces `rollup` (the GraphQL `statusCheckRollup` shape: `{ state,
 *  contexts: { nodes } }`) to a verdict against `dispositions` — a map from
 *  check name to `Disposition`, keyed by the same name `nameOf` reads
 *  (`config.ts`'s `loadConfig` builds this: the approval-gate's own derived
 *  excusal folded in as `source: 'approval-gate'`, every `checks.<name> =
 *  infrastructure` override in `CLAUDE.md` folded in as `source:
 *  'CLAUDE.md'`). An empty rollup is pending, never green.
 *
 *  `excused` names every disposition-excused check still found in the
 *  rollup, with its real conclusion and source — nothing an excused check
 *  reported is ever dropped from a listing. `unmatched` names a
 *  disposition entry whose check never appeared in the reduced rollup at
 *  all — reported, never treated as satisfied. **Zero evidence**: when the
 *  rollup is non-empty but every entry in it was excused, the verdict is
 *  `pending` with `zeroEvidence: true`, never green. */
export function rollupVerdict(rollup: any, dispositions: Record<string, Disposition> = {}): any {
  const contexts = rollup?.contexts?.nodes ?? [];
  if (contexts.length === 0) return { pending: true, red: [], green: [], excused: [], unmatched: [] };

  const reduced = reduceRollup(contexts);
  const isExcused = (e: any) => dispositions[nameOf(e) ?? '']?.disposition === 'infrastructure';

  const blocking = reduced.filter((e) => !isExcused(e));
  const excused = reduced
    .filter((e) => isExcused(e))
    .map((e) => ({ name: nameOf(e), conclusion: conclusionOf(e), source: dispositions[nameOf(e) ?? ''].source }));

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
