// Pure: label-state reconciliation, the cockpit half of #209 (#220). Per
// plugins/port/docs/PIPELINE.md → "Label lifecycle" → "State invariant":
// excluding the markers and the sanctioned refresh pair, an item holds at
// most one role-bearing label. This module inverts the 16 role-bearing
// aliases into a number → labels map, flags contradictions and issues with
// duplicate open pull requests, and computes change-only deltas for both —
// mirroring the shape `artifacts.mjs`'s `stageViolation` already enforces
// for pull requests alone, extended here to run every tick and to cover
// issues too. A contradictory item is removed from every action (dispatch,
// human gate, automatic write) and only ever reported — never repaired,
// never escalated (PIPELINE.md's own recorded rejection of that, restated
// where this module's callers read it).
import { LABEL_ROLES, LABEL_SURFACE } from './config.ts';

/** The one literal pair sanctioned to sit beside each other — never beside
 *  themselves twice over. Pinned against `artifacts.mjs`'s exported
 *  `PR_REFRESH_KEYS`, both directions, by `scripts/checks/tick.ts`. */
export const REFRESH_PAIR = ['refreshBranch', 'refreshing'];

/** Every trigger/in-flight/gate key, plus `approved` — the one terminal this
 *  engine still writes to (the approved re-verify). `prOpened` is
 *  deliberately absent: it only ever feeds the file-contention occupied set,
 *  never a dispatch, gate, or write of its own. */
export const ACTION_KEYS = [
  ...Object.keys(LABEL_ROLES).filter((k) => ['trigger', 'in-flight', 'gate'].includes((LABEL_ROLES as Record<string, string>)[k])),
  'approved',
];

const nonMarkerKeys = (keys: string[]): string[] =>
  keys.filter((k) => (LABEL_ROLES as Record<string, string>)[k] !== 'marker');

/** Inverts every role-bearing alias's nodes into `{ [number]: { keys,
 *  assignees } }` — one map covering both issues and pull requests, since
 *  the two surfaces share one number space per repository. `keys` names the
 *  aliases to read, in the order they should appear on each item's own
 *  `keys` list; `repository` is the tick's own GraphQL `repository` object. */
export function labelsByItem(repository: Record<string, any>, keys: string[]): Record<number, { keys: string[]; assignees: string[] }> {
  const byItem: Record<number, { keys: string[]; assignees: string[] }> = {};
  for (const key of keys) {
    const nodes = repository[key]?.nodes ?? [];
    for (const node of nodes) {
      const entry = byItem[node.number] ?? { keys: [], assignees: [] };
      entry.keys.push(key);
      for (const login of (node.assignees?.nodes ?? []).map((a: any) => a.login)) {
        if (!entry.assignees.includes(login)) entry.assignees.push(login);
      }
      byItem[node.number] = entry;
    }
  }
  return byItem;
}

/** Two or more role-bearing keys outside `REFRESH_PAIR`, or both
 *  `REFRESH_PAIR` keys at once — parity with `artifacts.mjs`'s
 *  `stageViolation`. Markers never count, even if a caller's map somehow
 *  carries one. */
function isContradiction(keys: string[]): boolean {
  const roleBearing = nonMarkerKeys(keys);
  const nonRefresh = roleBearing.filter((k) => !REFRESH_PAIR.includes(k));
  const bothRefresh = REFRESH_PAIR.every((k) => roleBearing.includes(k));
  return nonRefresh.length >= 2 || bothRefresh;
}

/** Every contradictory item, sorted by number: resolved label names, and an
 *  `owner` of `mine`/`other`/`unowned` against `viewer`. Reports every
 *  owner — acting stays `mine`-only, done by the caller via
 *  `actionablePartitions`. */
export function contradictions(
  byItem: Record<number, { keys: string[]; assignees: string[] }>,
  viewer: string | null,
  labels: Record<string, string>,
): Array<{ item: number; keys: string[]; labels: string[]; owner: string }> {
  const out: Array<{ item: number; keys: string[]; labels: string[]; owner: string }> = [];
  for (const [numStr, entry] of Object.entries(byItem)) {
    const keys = nonMarkerKeys(entry.keys);
    if (!isContradiction(keys)) continue;
    const owner = entry.assignees.length === 0 ? 'unowned' : entry.assignees.includes(viewer ?? '') ? 'mine' : 'other';
    out.push({ item: Number(numStr), keys, labels: keys.map((k) => labels[k]), owner });
  }
  return out.sort((a, b) => a.item - b.item);
}

/** A copy of `partitions` (the tick's own alias → `{ mine, others, unowned }`
 *  map, node objects carrying `.number`) with every `contradictory` number
 *  removed from each `ACTION_KEYS` alias's `mine` — never from `others` or
 *  `unowned`, and never from a non-action alias (`prOpened` stays
 *  untouched). The input is not mutated. */
export function actionablePartitions(
  partitions: Record<string, { mine: any[]; others: any[]; unowned: any[] }>,
  contradictory: number[],
): Record<string, { mine: any[]; others: any[]; unowned: any[] }> {
  const out: Record<string, { mine: any[]; others: any[]; unowned: any[] }> = {};
  for (const [key, value] of Object.entries(partitions)) {
    if (!ACTION_KEYS.includes(key)) {
      out[key] = value;
      continue;
    }
    out[key] = { ...value, mine: value.mine.filter((n: any) => !contradictory.includes(n.number)) };
  }
  return out;
}

/** Sorted unique issue numbers a pull request closes — the same two rungs
 *  `impl-agent.md`'s existing-work lookup already uses: `Closes #N`
 *  (case-insensitive, anywhere in the body) and a branch name's leading
 *  `N-` prefix. */
export function linkedIssues(pr: { body?: string | null; headRefName?: string | null }): number[] {
  const found = new Set<number>();
  for (const m of (pr.body ?? '').matchAll(/\bcloses #(\d+)\b/gi)) found.add(Number(m[1]));
  const branchMatch = /^(\d+)-/.exec(pr.headRefName ?? '');
  if (branchMatch) found.add(Number(branchMatch[1]));
  return [...found].sort((a, b) => a - b);
}

/** A PR → ticket map (#281), computed from the same `allOpenPRs` alias every
 *  tick, ownership-independent: display/selector input only, never a
 *  dispatch, gate, or write decision. Includes only open pull requests based
 *  on `integration` whose `linkedIssues()` returns **exactly one** issue — a
 *  pull request linking zero or two or more issues is omitted, so the
 *  cockpit falls back to that pull request's own number rather than guess.
 *  `branch` is the pull request's own `headRefName` when its leading `N-`
 *  equals the resolved issue, else `null` — the gate-clear branch selector
 *  (`writes.ts`'s `gateResolveWrite`) is only ever built from a `branch` that
 *  is not `null` here. */
export function ticketsByPullRequest(
  prs: Array<{ number: number; baseRefName?: string | null; body?: string | null; headRefName?: string | null }>,
  integration: string,
): Record<number, { issue: number; branch: string | null }> {
  const out: Record<number, { issue: number; branch: string | null }> = {};
  for (const pr of prs) {
    if (pr.baseRefName !== integration) continue;
    const issues = linkedIssues(pr);
    if (issues.length !== 1) continue;
    const issue = issues[0];
    const branchMatch = /^(\d+)-/.exec(pr.headRefName ?? '');
    const branch = branchMatch && Number(branchMatch[1]) === issue ? (pr.headRefName as string) : null;
    out[pr.number] = { issue, branch };
  }
  return out;
}

/** Every issue linked by two or more open pull requests whose `baseRefName`
 *  is `integration` — a release pull request into `<production>` is never
 *  counted. Each pull request's `labels` are its own role-bearing resolved
 *  names (never the marker, never an issue-only key), read off the raw
 *  GraphQL node. */
export function duplicatePullRequests(
  prs: Array<{ number: number; baseRefName?: string | null; body?: string | null; headRefName?: string | null; labels?: { nodes?: Array<{ name: string }> } }>,
  integration: string,
  labels: Record<string, string>,
): Array<{ issue: number; prs: Array<{ number: number; labels: string[] }> }> {
  const roleBearingPrNames = new Set(
    Object.keys(LABEL_ROLES)
      .filter((k) => (LABEL_ROLES as Record<string, string>)[k] !== 'marker' && (LABEL_SURFACE as Record<string, string>)[k] !== 'issue')
      .map((k) => labels[k]),
  );

  const byIssue = new Map<number, Array<{ number: number; labels: string[] }>>();
  for (const pr of prs) {
    if (pr.baseRefName !== integration) continue;
    const prLabels = (pr.labels?.nodes ?? []).map((l) => l.name).filter((n) => roleBearingPrNames.has(n));
    for (const issue of linkedIssues(pr)) {
      const list = byIssue.get(issue) ?? [];
      list.push({ number: pr.number, labels: prLabels });
      byIssue.set(issue, list);
    }
  }

  const out: Array<{ issue: number; prs: Array<{ number: number; labels: string[] }> }> = [];
  for (const [issue, list] of byIssue) {
    if (list.length < 2) continue;
    out.push({ issue, prs: [...list].sort((a, b) => a.number - b.number) });
  }
  return out.sort((a, b) => a.issue - b.issue);
}

/** The ungated-sweep filter, moved verbatim out of `port-tick.ts` to free
 *  its line budget (#220) — behaviour-identical. A pull request carrying any
 *  stage label but not the marker never got the merge gate live on it. */
export function ungatedPullRequests(prs: Array<{ number: number; labels?: { nodes?: Array<{ name: string }> } }>, labels: Record<string, string>): number[] {
  const stageLabelNames = new Set([
    labels.readyForReview, labels.reviewing, labels.needsRevision,
    labels.revising, labels.approved, labels.needsHuman,
    labels.refreshBranch, labels.refreshing,
  ]);
  return prs
    .filter((pr) => {
      const names = (pr.labels?.nodes ?? []).map((l) => l.name);
      return names.some((n) => stageLabelNames.has(n)) && !names.includes(labels.marker);
    })
    .map((pr) => pr.number);
}

/** The tick's own composition root for this module (line-budget headroom for
 *  `port-tick.ts`, #220): builds the co-presence map, flags contradictions
 *  and duplicate pull requests, and reduces both to their change-only report
 *  against the two remembered signature sets — everything `plan`'s own
 *  `reconcile`/`reconcilePersist` fields need, in one call. Each family's
 *  `complete` is false whenever any alias it reads came back unavailable or
 *  truncated this tick. */
export function reconcileTick({
  repository,
  roleBearingKeys,
  viewer,
  labels,
  integration,
  envelopeUnavailable,
  truncated,
  contradictionsReported,
  duplicatesReported,
}: {
  repository: Record<string, any>;
  roleBearingKeys: string[];
  viewer: string | null;
  labels: Record<string, string>;
  integration: string;
  envelopeUnavailable: string[];
  truncated: string[];
  contradictionsReported: string[];
  duplicatesReported: string[];
}): { contradictoryNumbers: number[]; reconcile: any; persist: { contradictions: string[]; duplicates: string[] } } {
  const byItem = labelsByItem(repository, roleBearingKeys);
  const contradictionsList = contradictions(byItem, viewer, labels);
  const openPRs = repository.allOpenPRs?.nodes ?? [];
  const duplicatesList = duplicatePullRequests(openPRs, integration, labels);

  const contradictionSigs = contradictionsList.map((c) => ({ sig: `${c.item}:${c.keys.join('+')}`, ...c }));
  const duplicateSigs = duplicatesList.map((d) => ({ sig: `${d.issue}:${d.prs.map((p) => p.number).join(',')}`, ...d }));
  const contradictionsComplete = roleBearingKeys.every((k) => !envelopeUnavailable.includes(k) && !truncated.includes(k));
  const duplicatesComplete = !envelopeUnavailable.includes('allOpenPRs') && !truncated.includes('allOpenPRs');
  const contradictionDelta = reportDelta(contradictionsReported, contradictionSigs, contradictionsComplete);
  const duplicateDelta = reportDelta(duplicatesReported, duplicateSigs, duplicatesComplete);

  return {
    contradictoryNumbers: contradictionsList.map((c) => c.item),
    reconcile: {
      complete: { contradictions: contradictionsComplete, duplicates: duplicatesComplete },
      contradictions: contradictionDelta.entries,
      duplicates: duplicateDelta.entries,
      cleared: { contradictions: contradictionDelta.cleared, duplicates: duplicateDelta.cleared },
    },
    persist: { contradictions: contradictionDelta.persist, duplicates: duplicateDelta.persist },
  };
}

/** Applies change-only reporting to the liveness diff's two report-only
 *  classes (`no-record`, `capped`) — `suspect`/`reset` change every tick by
 *  definition, so they always get `repeat: false`. Mutates each `liveness`
 *  entry (`commit`'s own per-item classification) with its own `repeat` and
 *  returns the signature set to persist as `orphansReported`. Line-budget
 *  headroom for `port-tick.ts` (#220), same shape as `buildLivenessExpected`. */
export function reportOrphans(liveness: Array<{ item: number; class: string; repeat?: boolean }>, orphansReported: string[]): string[] {
  const candidates = liveness
    .filter((l) => l.class === 'no-record' || l.class === 'capped')
    .map((l) => ({ sig: `${l.item}:${l.class}` }));
  const delta = reportDelta(orphansReported, candidates, true);
  const repeatBySig = new Map(delta.entries.map((e) => [e.sig, e.repeat]));
  for (const l of liveness) {
    l.repeat = (repeatBySig.get(`${l.item}:${l.class}`) as boolean | undefined) ?? false;
  }
  return delta.persist;
}

/** Change-only delta against a remembered signature set. `complete: true`
 *  (every feeding alias came back whole) announces a clear for every
 *  previous signature now absent; `complete: false` never announces a
 *  clear, and carries every previous signature forward alongside the
 *  current ones so an incomplete read never drops what a prior tick already
 *  proved. Each entry in `current` gains `repeat` — whether its own `sig`
 *  was already reported last tick. */
export function reportDelta(
  previous: string[],
  current: Array<{ sig: string; [k: string]: unknown }>,
  complete: boolean,
): { entries: Array<{ sig: string; [k: string]: unknown; repeat: boolean }>; cleared: string[]; persist: string[] } {
  const entries = current.map((c) => ({ ...c, repeat: previous.includes(c.sig) }));
  const currentSigs = current.map((c) => c.sig);
  if (!complete) {
    return { entries, cleared: [], persist: [...new Set([...previous, ...currentSigs])] };
  }
  const cleared = previous.filter((sig) => !currentSigs.includes(sig));
  return { entries, cleared, persist: currentSigs };
}
