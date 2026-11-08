// Pure: the statusCheckRollup reduction contract. Reduces to the latest entry per check name,
// then reads the verdict — never trusting `gh pr checks`'s exit code, never reading an empty rollup as green.
import type { CheckStatus, IntegrationStatus, ZeroDiffChecks } from './gates.ts';

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
  readonly detailsUrl?: string | null;
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

const ACTIONS_JOB_URL = /\/actions\/runs\/(\d+)\/job\/(\d+)/;

/** The run and job a GitHub Actions check run's details URL names, or null for a
 *  StatusContext or any external CI, which `gh run rerun` cannot reach. */
export function actionsJobOf(url: string | null | undefined): { readonly runId: string; readonly jobId: string } | null {
  const m = ACTIONS_JOB_URL.exec(url ?? '');
  return m === null ? null : { runId: m[1] ?? '', jobId: m[2] ?? '' };
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

/** A concluded entry whose conclusion counts as passing. */
export function isGreen(entry: CheckContext): boolean {
  return isConcluded(entry) && GREEN.has(conclusionOf(entry) ?? '');
}

/** The reduced rollup `gates.ts`'s zero-diff gate reads — built here so that module stays a leaf. */
export function zeroDiffChecksOf(contexts: readonly CheckContext[] | null, dispositions: Readonly<Record<string, Disposition>>, now: string | null): ZeroDiffChecks {
  const statuses = new Map<string, CheckStatus>();
  for (const c of reduceRollup(contexts ?? undefined)) {
    statuses.set(nameOf(c) ?? '', isGreen(c) ? 'green' : isConcluded(c) ? 'red' : 'pending');
  }
  const verdict = rollupVerdict(contexts, dispositions);
  return { statuses, rollupClear: verdict.red.length === 0 && !verdict.pending, now };
}

/** One integration-branch commit as the history alias returns it. */
export interface IntegrationCommit {
  readonly statusCheckRollup?: { readonly contexts?: { readonly nodes?: readonly CheckContext[] | null } | null } | null;
}

/** Each check name's latest concluded status across the integration history, newest commit first;
 *  `undefined` when the history is absent or errored, so an unreadable read is never an empty one. */
export function integrationChecksOf(history: readonly IntegrationCommit[] | null | undefined): ReadonlyMap<string, IntegrationStatus> | undefined {
  if (history == null) return undefined;
  const statuses = new Map<string, IntegrationStatus>();
  for (const commit of history) {
    for (const c of reduceRollup(commit.statusCheckRollup?.contexts?.nodes ?? undefined)) {
      const name = nameOf(c);
      if (name === null || statuses.has(name) || !isConcluded(c)) continue;
      statuses.set(name, isGreen(c) ? 'green' : 'red');
    }
  }
  return statuses;
}

/** A single check's disposition: `blocking` (default — a red conclusion forms a finding and
 *  blocks) or `infrastructure` (reported, no finding, never blocks). `source` names where it came from. */
export interface Disposition {
  readonly disposition: 'blocking' | 'infrastructure';
  readonly source: 'approval-gate' | 'CLAUDE.md' | 'artifacts-audit';
}

/** The blocking checks that grade the pull request's own review history, which no revision can change. */
export function historyDerivedChecks(dispositions: Readonly<Record<string, Disposition>>): string[] {
  return Object.entries(dispositions)
    .filter(([, d]) => d.source === 'artifacts-audit' && d.disposition === 'blocking')
    .map(([name]) => name);
}

/** Minutes a requested rerun may stay invisible in the rollup before review is dispatched anyway. */
export const CHECK_RERUN_VISIBLE_MINUTES = 10;

/** Per pull request: the head a rerun was issued on, and when each check's rerun was requested. */
export interface RerunRecord {
  readonly sha: string;
  readonly checks: Readonly<Record<string, string>>;
}

export type PreReviewRerun =
  | { readonly action: 'rerun'; readonly checks: readonly string[]; readonly runs: readonly { readonly check: string; readonly runId: string }[] }
  | { readonly action: 'hold'; readonly checks: readonly string[] }
  | { readonly action: 'proceed' };

/** A red blocking Actions check not yet rerun on this head gets one rerun, and review is held until it concludes.
 *  A new head resets the budget; a rerun that never shows ends the hold after `CHECK_RERUN_VISIBLE_MINUTES`. */
export function preReviewRerun({
  contexts,
  dispositions,
  headRefOid,
  reran,
  now,
}: {
  readonly contexts: readonly CheckContext[] | null | undefined;
  readonly dispositions: Readonly<Record<string, Disposition>>;
  readonly headRefOid: string;
  readonly reran: RerunRecord | undefined;
  readonly now: string | null;
}): PreReviewRerun {
  const excluded = new Set(historyDerivedChecks(dispositions));
  const recorded = reran?.sha === headRefOid ? reran.checks : {};
  const nowMs = now === null ? Number.NaN : Date.parse(now);
  const candidates: { check: string; runId: string }[] = [];
  const held: string[] = [];

  for (const c of reduceRollup(contexts ?? undefined)) {
    const name = nameOf(c);
    if (name === null || excluded.has(name) || dispositions[name]?.disposition === 'infrastructure') continue;
    const at = recorded[name];
    if (at === undefined) {
      const job = isConcluded(c) && !GREEN.has(conclusionOf(c) ?? '') ? actionsJobOf(c.detailsUrl ?? c.url) : null;
      if (job !== null) candidates.push({ check: name, runId: job.runId });
      continue;
    }
    if (!isConcluded(c)) {
      held.push(name);
      continue;
    }
    const requested = Date.parse(at);
    const started = Date.parse(timeOf(c) ?? '');
    const invisible = started < requested && !Number.isNaN(nowMs) && nowMs < requested + CHECK_RERUN_VISIBLE_MINUTES * 60_000;
    if (invisible) held.push(name);
  }

  if (candidates.length > 0) {
    const seen = new Set<string>();
    const runs = candidates.filter((x) => !seen.has(x.runId) && seen.add(x.runId));
    return { action: 'rerun', checks: candidates.map((x) => x.check), runs };
  }
  return held.length > 0 ? { action: 'hold', checks: held } : { action: 'proceed' };
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
