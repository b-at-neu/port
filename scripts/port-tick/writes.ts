// Pure: every `gh` label-edit command string the tick engine emits, and
// nothing else. #225 found the additive-vs-swap distinction between the
// approved and readyForReview refresh paths living un-tested inside
// port-tick.ts's own inline template literals — the one layer with no case
// table. This module is that table's implementation: every label name
// arrives already resolved through `cfg.labels`; no default label string is
// a literal here (docs/ENGINEERING.md §1).
//
// #236: `target` ('issue' vs 'pr') used to be a literal the caller typed by
// hand, which every write got right except `livenessResetWrite` — hardcoded
// to 'issue', wrong for the three in-flight labels that only ever apply to a
// pull request. Every write now composes through `labelEdit`, which derives
// `target` from `LABEL_SURFACE`, so the class of bug (a caller typing the
// wrong surface) is unreachable rather than merely fixed once. No
// `'issue'`/`'pr'` string literal remains below this point.
import { LABEL_SURFACE } from './config.ts';

/** One shared formatter. `removeKey`/`addKey` are config label keys (never
 *  resolved names) — `target` is derived from `LABEL_SURFACE[removeKey ??
 *  addKey]` (the subject label: the one the item currently carries), and
 *  both names are resolved through `labels[...]`. `--remove-label` is
 *  omitted entirely when `removeKey` is falsy, never emitted as an empty
 *  string — every exported write below composes through this, so a
 *  label-flag typo, or a wrong-surface `gh` subcommand, only has one place
 *  to happen. */
function labelEdit({
  removeKey,
  addKey,
  number,
  repo,
  labels,
}: {
  removeKey: string | null;
  addKey: string;
  number: number;
  repo: string;
  labels: Record<string, string>;
}): string {
  const target = (LABEL_SURFACE as Record<string, string>)[removeKey ?? addKey];
  const removePart = removeKey ? ` --remove-label "${labels[removeKey]}"` : '';
  return `gh ${target} edit ${number} --repo ${repo}${removePart} --add-label "${labels[addKey]}"`;
}

/** The refresh sweep's asymmetry, in one place (#225). `candidate` is
 *  `{ number, sourceLabelKey }` — `sourceLabelKey` is `'readyForReview'` or
 *  `'approved'`, whichever trigger/status label this pull request entered
 *  the sweep carrying. `decision` is `gates.ts`'s `refreshDecision` output.
 *
 *  `action: 'refresh'` — add `labels.refreshBranch`, remove nothing, on
 *  **both** paths. The trigger survives because `gates.ts`'s `refreshWins`
 *  veto, not a removal, is what stops a second dispatch — and because
 *  refresh mode's clean-rebase handoff adds no label back, so a removal
 *  here would strand the pull request at no stage label at all.
 *
 *  `action: 'escalate'` — remove `labels[candidate.sourceLabelKey]` and add
 *  `labels.needsHuman`. This is #225's second symptom, closed in both
 *  directions: escalating a `readyForReview` candidate now removes `ready
 *  for review`, not only `approved`. */
export function refreshSweepWrite({ repo, labels, candidate, decision }: { repo: string; labels: Record<string, string>; candidate: any; decision: any }): any {
  if (decision.action === 'escalate') {
    return {
      command: labelEdit({ removeKey: candidate.sourceLabelKey, addKey: 'needsHuman', number: candidate.number, repo, labels }),
      why: `refresh sweep: ${decision.reason}`,
    };
  }
  return {
    command: labelEdit({ removeKey: null, addKey: 'refreshBranch', number: candidate.number, repo, labels }),
    why: 'refresh sweep: rebase + force-push, no code changes',
  };
}

/** The newest `## Code Review` already covers the current head with no
 *  `## Gate cleared` since — no second review cycle without operator
 *  authorisation. */
export function zeroDiffWrite({ repo, labels, number }: { repo: string; labels: Record<string, string>; number: number }): any {
  return {
    command: labelEdit({ removeKey: 'readyForReview', addKey: 'needsHuman', number, repo, labels }),
    why: 'zero-diff review gate',
  };
}

/** Unconditional — fires at or over `reviewCycleCap` whatever the latest
 *  review said. */
export function cycleCapWrite({ repo, labels, number }: { repo: string; labels: Record<string, string>; number: number }): any {
  return {
    command: labelEdit({ removeKey: 'needsRevision', addKey: 'needsHuman', number, repo, labels }),
    why: 'cycle cap reached',
  };
}

/** A check on an `<labels.approved>` pull request has gone red since
 *  approval — the one non-refresh route off the terminal state. */
export function approvalWithdrawnWrite({ repo, labels, number }: { repo: string; labels: Record<string, string>; number: number }): any {
  return {
    command: labelEdit({ removeKey: 'approved', addKey: 'needsRevision', number, repo, labels }),
    why: 'approval withdrawn: red check',
  };
}

/** A provably-dead dispatch (liveness's `reset` classification) hands the
 *  item back to its trigger label. `fromKey`/`toKey` are config label keys
 *  — `toKey` is `RETRY_TRIGGER`'s value for the in-flight label the item was
 *  found at — resolved through `labels` here, the same `{ repo, labels, … }`
 *  shape every other write in this module already takes. This is the #236
 *  fix: `target` used to be hardcoded `'issue'`, wrong for `reviewing`,
 *  `revising`, and `refreshing`, which only ever apply to a pull request;
 *  `labelEdit` now derives it from `LABEL_SURFACE[fromKey]` like every other
 *  write. */
export function livenessResetWrite({
  repo,
  labels,
  item,
  fromKey,
  toKey,
}: {
  repo: string;
  labels: Record<string, string>;
  item: number;
  fromKey: string;
  toKey: string;
}): any {
  return {
    command: labelEdit({ removeKey: fromKey, addKey: toKey, number: item, repo, labels }),
    why: `liveness reset: ${labels[fromKey]} → ${labels[toKey]}`,
  };
}

/** The four `resolve --decision` answers a human gate accepts: two on the
 *  plan-review gate (an issue), two clearing `<labels.needsHuman>` (a pull
 *  request). Returns `null` for an unrecognized decision — the caller turns
 *  that into the CLI's own error. */
export function gateResolveWrite({ repo, labels, item, decision }: { repo: string; labels: Record<string, string>; item: number; decision: string }): any {
  if (decision === 'approve') {
    return { command: labelEdit({ removeKey: 'planReview', addKey: 'planApproved', number: item, repo, labels }), why: 'plan review: approved' };
  }
  if (decision === 'changes') {
    return { command: labelEdit({ removeKey: 'planReview', addKey: 'planChangesRequested', number: item, repo, labels }), why: 'plan review: changes requested' };
  }
  if (decision === 'back-to-revision') {
    return { command: labelEdit({ removeKey: 'needsHuman', addKey: 'needsRevision', number: item, repo, labels }), why: 'gate cleared: back to revision' };
  }
  if (decision === 'back-to-review') {
    return { command: labelEdit({ removeKey: 'needsHuman', addKey: 'readyForReview', number: item, repo, labels }), why: 'gate cleared: back to review' };
  }
  return null;
}
