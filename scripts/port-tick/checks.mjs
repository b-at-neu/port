// Pure: the statusCheckRollup reduction contract from
// plugins/port/docs/PIPELINE.md → "Check evidence". Reduces to the latest
// entry per check name, then reads the verdict — never trusting `gh pr
// checks`'s exit code, and never reading an empty rollup as green.
const GREEN = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** `(.name // .context)` — the field a CheckRun and a StatusContext each
 *  carry the check's identity under. */
const nameOf = (c) => c.name ?? c.context ?? null;

/** The sortable moment a context reports itself at: `startedAt` for a
 *  CheckRun, falling back to `completedAt`, then a StatusContext's
 *  `createdAt` — whichever this union member actually carries. */
const timeOf = (c) => c.startedAt ?? c.completedAt ?? c.createdAt ?? null;

/** Reduces a rollup's `contexts.nodes` to the latest entry per check name by
 *  `timeOf`, since the approval gate alone re-runs on every labeled event and
 *  a pull request that has been through a few label changes can carry
 *  several entries for the same name. */
export function reduceRollup(contexts) {
  const latest = new Map();
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
export function isConcluded(entry) {
  if (entry.__typename === 'StatusContext') return entry.state !== 'PENDING';
  return entry.status === 'COMPLETED';
}

/** `(.conclusion // .state)` — CheckRun's conclusion, or a StatusContext's
 *  state, whichever this entry carries. */
export function conclusionOf(entry) {
  return entry.conclusion ?? entry.state ?? null;
}

/** Reduces `rollup` (the GraphQL `statusCheckRollup` shape: `{ state,
 *  contexts: { nodes } }`) to a verdict against `excusedCheckName` (the
 *  single approval-gate job name, or `null` when `modules.approvalGate` is
 *  false or the workflow file is absent — "no carve-out at all, and every
 *  red check blocks"). An empty rollup is pending, never green. */
export function rollupVerdict(rollup, excusedCheckName) {
  const contexts = rollup?.contexts?.nodes ?? [];
  if (contexts.length === 0) return { pending: true, red: [], green: [] };

  const reduced = reduceRollup(contexts).filter((e) => nameOf(e) !== excusedCheckName);
  const pending = reduced.some((e) => !isConcluded(e));
  const red = reduced.filter((e) => isConcluded(e) && !GREEN.has(conclusionOf(e))).map((e) => ({ name: nameOf(e), conclusion: conclusionOf(e) }));
  const green = reduced.filter((e) => isConcluded(e) && GREEN.has(conclusionOf(e))).map((e) => nameOf(e));

  return { pending: pending && red.length === 0, red, green };
}
