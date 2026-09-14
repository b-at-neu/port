// Pure: every `gh` label-edit command string the tick engine emits, and
// nothing else. #225 found the additive-vs-swap distinction between the
// approved and readyForReview refresh paths living un-tested inside
// port-tick.mjs's own inline template literals — the one layer with no case
// table. This module is that table's implementation: every label name
// arrives already resolved through `cfg.labels`; no default label string is
// a literal here (docs/ENGINEERING.md §1).

/** One shared formatter. `target` is `'issue'` or `'pr'`; `--remove-label`
 *  is omitted entirely when `remove` is falsy, never emitted as an empty
 *  string — every exported write below composes through this, so a
 *  label-flag typo only has one place to happen. */
function labelEdit({ target, number, repo, remove, add }) {
  const removePart = remove ? ` --remove-label "${remove}"` : '';
  return `gh ${target} edit ${number} --repo ${repo}${removePart} --add-label "${add}"`;
}

/** The refresh sweep's asymmetry, in one place (#225). `candidate` is
 *  `{ number, sourceLabelKey }` — `sourceLabelKey` is `'readyForReview'` or
 *  `'approved'`, whichever trigger/status label this pull request entered
 *  the sweep carrying. `decision` is `gates.mjs`'s `refreshDecision` output.
 *
 *  `action: 'refresh'` — add `labels.refreshBranch`, remove nothing, on
 *  **both** paths. The trigger survives because `gates.mjs`'s `refreshWins`
 *  veto, not a removal, is what stops a second dispatch — and because
 *  refresh mode's clean-rebase handoff adds no label back, so a removal
 *  here would strand the pull request at no stage label at all.
 *
 *  `action: 'escalate'` — remove `labels[candidate.sourceLabelKey]` and add
 *  `labels.needsHuman`. This is #225's second symptom, closed in both
 *  directions: escalating a `readyForReview` candidate now removes `ready
 *  for review`, not only `approved`. */
export function refreshSweepWrite({ repo, labels, candidate, decision }) {
  if (decision.action === 'escalate') {
    return {
      command: labelEdit({ target: 'pr', number: candidate.number, repo, remove: labels[candidate.sourceLabelKey], add: labels.needsHuman }),
      why: `refresh sweep: ${decision.reason}`,
    };
  }
  return {
    command: labelEdit({ target: 'pr', number: candidate.number, repo, remove: '', add: labels.refreshBranch }),
    why: 'refresh sweep: rebase + force-push, no code changes',
  };
}

/** The newest `## Code Review` already covers the current head with no
 *  `## Gate cleared` since — no second review cycle without operator
 *  authorisation. */
export function zeroDiffWrite({ repo, labels, number }) {
  return {
    command: labelEdit({ target: 'pr', number, repo, remove: labels.readyForReview, add: labels.needsHuman }),
    why: 'zero-diff review gate',
  };
}

/** Unconditional — fires at or over `reviewCycleCap` whatever the latest
 *  review said. */
export function cycleCapWrite({ repo, labels, number }) {
  return {
    command: labelEdit({ target: 'pr', number, repo, remove: labels.needsRevision, add: labels.needsHuman }),
    why: 'cycle cap reached',
  };
}

/** A check on an `<labels.approved>` pull request has gone red since
 *  approval — the one non-refresh route off the terminal state. */
export function approvalWithdrawnWrite({ repo, labels, number }) {
  return {
    command: labelEdit({ target: 'pr', number, repo, remove: labels.approved, add: labels.needsRevision }),
    why: 'approval withdrawn: red check',
  };
}

/** A provably-dead dispatch (liveness's `reset` classification) hands the
 *  item back to its trigger label. `from`/`to` arrive already resolved —
 *  `to` is `RETRY_TRIGGER`'s key resolved through `cfg.labels` by the
 *  caller, so a repository overriding a label name still hits the right
 *  trigger. */
export function livenessResetWrite({ repo, item, from, to }) {
  return {
    command: labelEdit({ target: 'issue', number: item, repo, remove: from, add: to }),
    why: `liveness reset: ${from} → ${to}`,
  };
}

/** The four `resolve --decision` answers a human gate accepts: two on the
 *  plan-review gate (an issue), two clearing `<labels.needsHuman>` (a pull
 *  request). Returns `null` for an unrecognized decision — the caller turns
 *  that into the CLI's own error. */
export function gateResolveWrite({ repo, labels, item, decision }) {
  if (decision === 'approve') {
    return { command: labelEdit({ target: 'issue', number: item, repo, remove: labels.planReview, add: labels.planApproved }), why: 'plan review: approved' };
  }
  if (decision === 'changes') {
    return { command: labelEdit({ target: 'issue', number: item, repo, remove: labels.planReview, add: labels.planChangesRequested }), why: 'plan review: changes requested' };
  }
  if (decision === 'back-to-revision') {
    return { command: labelEdit({ target: 'pr', number: item, repo, remove: labels.needsHuman, add: labels.needsRevision }), why: 'gate cleared: back to revision' };
  }
  if (decision === 'back-to-review') {
    return { command: labelEdit({ target: 'pr', number: item, repo, remove: labels.needsHuman, add: labels.readyForReview }), why: 'gate cleared: back to review' };
  }
  return null;
}
