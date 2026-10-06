// Pure: every `gh` label-edit command string the tick engine emits. Every write composes
// through `labelEdit`, which derives `target` ('issue' vs 'pr') from `LABEL_SURFACE`.
import { LABEL_SURFACE } from './config.ts';

/** One shared formatter; `target` derives from `LABEL_SURFACE[removeKey ?? addKey]`.
 *  `selector`, when given, replaces `number` with a validated branch selector. */
function labelEdit({
  removeKey,
  addKey,
  number,
  selector,
  repo,
  labels,
}: {
  removeKey: string | null;
  addKey: string;
  number: number;
  selector?: string | null;
  repo: string;
  labels: Record<string, string>;
}): string {
  const target = (LABEL_SURFACE as Record<string, string>)[removeKey ?? addKey];
  const removePart = removeKey ? ` --remove-label "${labels[removeKey]}"` : '';
  const subject = selector ? `"${selector}"` : String(number);
  return `gh ${target} edit ${subject} --repo ${repo}${removePart} --add-label "${labels[addKey]}"`;
}

/** The refresh sweep's asymmetry, in one place. `action: 'refresh'` adds `labels.refreshBranch`
 *  and removes nothing; `action: 'escalate'` removes `labels[candidate.sourceLabelKey]` and adds `labels.needsHuman`. */
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

/** The newest review already covers the current head with no `## Gate cleared` since. */
export function zeroDiffWrite({ repo, labels, number }: { repo: string; labels: Record<string, string>; number: number }): any {
  return {
    command: labelEdit({ removeKey: 'readyForReview', addKey: 'needsHuman', number, repo, labels }),
    why: 'zero-diff review gate',
  };
}

/** Unconditional — fires at or over `reviewCycleCap` whatever the latest review said. */
export function cycleCapWrite({ repo, labels, number }: { repo: string; labels: Record<string, string>; number: number }): any {
  return {
    command: labelEdit({ removeKey: 'needsRevision', addKey: 'needsHuman', number, repo, labels }),
    why: 'cycle cap reached',
  };
}

/** A check on an `<labels.approved>` pull request has gone red since approval. */
export function approvalWithdrawnWrite({ repo, labels, number }: { repo: string; labels: Record<string, string>; number: number }): any {
  return {
    command: labelEdit({ removeKey: 'approved', addKey: 'needsRevision', number, repo, labels }),
    why: 'approval withdrawn: red check',
  };
}

/** A provably-dead dispatch hands the item back to its trigger label. `toKey` is
 *  `RETRY_TRIGGER`'s value for the in-flight label the item was found at. */
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

// A `gh pr edit` branch selector: leading digits, a dash, then the rest of the branch name.
const BRANCH_SELECTOR_RE = /^\d+-[\w./-]+$/;

/** The four `resolve --decision` answers a human gate accepts. Returns `null` for an
 *  unrecognized decision, or an invalid `branch`, or one paired with a plan-review decision. */
export function gateResolveWrite({
  repo,
  labels,
  item,
  decision,
  branch,
}: {
  repo: string;
  labels: Record<string, string>;
  item: number;
  decision: string;
  branch?: string | null;
}): any {
  if (branch != null && (decision === 'approve' || decision === 'changes')) return null;
  if (decision === 'approve') {
    return { command: labelEdit({ removeKey: 'planReview', addKey: 'planApproved', number: item, repo, labels }), why: 'plan review: approved' };
  }
  if (decision === 'changes') {
    return { command: labelEdit({ removeKey: 'planReview', addKey: 'planChangesRequested', number: item, repo, labels }), why: 'plan review: changes requested' };
  }
  let selector: string | undefined;
  if (branch != null) {
    if (!BRANCH_SELECTOR_RE.test(branch)) return null;
    selector = branch;
  }
  if (decision === 'back-to-revision') {
    return { command: labelEdit({ removeKey: 'needsHuman', addKey: 'needsRevision', number: item, selector, repo, labels }), why: 'gate cleared: back to revision' };
  }
  if (decision === 'back-to-review') {
    return { command: labelEdit({ removeKey: 'needsHuman', addKey: 'readyForReview', number: item, selector, repo, labels }), why: 'gate cleared: back to review' };
  }
  return null;
}
