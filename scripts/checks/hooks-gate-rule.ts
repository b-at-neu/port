import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from '../lib/files.ts';
import { resolveMatchers, subagentPayload, plainPayload, makeCheck, makeDecide, bash } from '../lib/guard-fixtures.ts';
import type { Reporter } from '../lib/report.ts';

export default async function ({ fail, ok, expect }: Reporter) {
  const { decide } = await import(pathToFileURL(join(root, 'plugins/port/hooks/lib/guard-rules.mjs')).href);
  const { recentOperatorMessages, operatorNamed } =
    await import(pathToFileURL(join(root, 'plugins/port/hooks/lib/operator-rules.mjs')).href);
  const { gateClearAttempt } = await import(pathToFileURL(join(root, 'plugins/port/hooks/lib/command-rules.mjs')).href);

  const matchers = resolveMatchers(fail);
  const check = makeCheck(fail, ok);

  // --- Cockpit rules: gate rule ------------------------------------------------
  // guard(#138, #142, #281): the cockpit clearing its own needs-human gate under throughput pressure, unverified; #281 adds the gh pr edit branch-selector rung so `unblock #<ticket>` clears via the pull request's own branch too.
  const needsHumanLabel = 'needs human';
  const gate = makeDecide(decide, { matchers, sessionRequiredPaths: [], root, needsHumanLabel });

  // A gate-clear attempt with operator messages naming a different item →
  // denied.
  check(
    '#138 gate clear denied — operator named a different item',
    gate({
      payload: bash('gh pr edit 134 --repo b-at-neu/port --remove-label "needs human" --add-label "needs revision"'),
      operatorMessages: ['reset #63 back to ready', 'thanks, thats everything for now'],
    }),
    'deny',
  );

  // Same command, with a message naming pull request 134 → gate-clear
  // (allowed and logged as the audit record, never a plain 'allow').
  check(
    '#138 gate clear allowed — operator named the item',
    gate({
      payload: bash('gh pr edit 134 --repo b-at-neu/port --remove-label "needs human" --add-label "needs revision"'),
      operatorMessages: ['unblock #134'],
    }),
    'gate-clear',
  );

  // Same command, transcript unreadable (operatorMessages: null) →
  // unverifiable, not unauthorised — gate-clear, never a silent deny.
  check(
    '#138 gate clear with an unreadable transcript',
    gate({
      payload: bash('gh pr edit 134 --repo b-at-neu/port --remove-label "needs human" --add-label "needs revision"'),
      operatorMessages: null,
    }),
    'gate-clear',
  );

  // #142/R1-C1 — a gate-clear attempt with no bare digit and no issues/pull
  // URL, and a branch with no leading N- (which `gh` still accepts as an
  // identifier), must be denied outright, never fall through to
  // operatorNamed's vacuously-true `[].every(...)` on an empty numbers
  // array. Even an operator message that would otherwise satisfy some
  // *other* item must not let this through — there is nothing here for it
  // to have named.
  check(
    '#142 gate clear denied — command names no item number (branch form, no leading N-)',
    gate({
      payload: bash('gh pr edit my-feature-branch --repo b-at-neu/port --remove-label "needs human"'),
      operatorMessages: ['unblock #134'],
    }),
    'deny',
  );

  // #281 — a branch selector with a leading N- names N for `gh pr edit`
  // (never for `gh issue edit`, which has no branch selector at all), so
  // `unblock #<ticket>` now clears the gate through the pull request's own
  // branch, not only through its numeric id. Once this branch rung is in
  // play, the 139-guard-… case below is denied because 139 was not named,
  // not because nothing was named — reworded from its prior comment.
  check(
    '#281 gate clear allowed — branch selector names the ticket the operator named',
    gate({
      payload: bash('gh pr edit "281-cockpit-ticket-numbers" --repo b-at-neu/port --remove-label "needs human" --add-label "needs revision"'),
      operatorMessages: ['unblock #281'],
    }),
    'gate-clear',
  );

  // Same command, operator named a different item — denied: naming the
  // pull request's own number never substitutes for naming the ticket the
  // branch selector resolves to.
  check(
    '#281 gate clear denied — branch selector names a ticket the operator did not name',
    gate({
      payload: bash('gh pr edit "281-cockpit-ticket-numbers" --repo b-at-neu/port --remove-label "needs human" --add-label "needs revision"'),
      operatorMessages: ['unblock #290'],
    }),
    'deny',
  );

  // No prefix collision: a branch numbered 2810 never satisfies "the
  // operator named #281" merely because '281' is a leading substring of
  // '2810'.
  check(
    '#281 gate clear denied — no prefix collision between 281 and 2810',
    gate({
      payload: bash('gh pr edit 2810-x --repo b-at-neu/port --remove-label "needs human"'),
      operatorMessages: ['unblock #281'],
    }),
    'deny',
  );

  // The pre-existing 139-guard-… case stays deny, now for a different
  // reason: the branch rung extracts 139, so this is "operator named a
  // different item", not "command names no item number".
  check(
    '#142 gate clear denied — operator named a different item (139-guard-… branch names 139)',
    gate({
      payload: bash('gh pr edit 139-guard-cockpit-loop-and-gate-rules --repo b-at-neu/port --remove-label "needs human"'),
      operatorMessages: ['unblock #134'],
    }),
    'deny',
  );

  // Same bug, the no-identifier-at-all form (`gh` defaults to the current
  // branch's PR).
  check(
    '#142 gate clear denied — command names no item number (no identifier)',
    gate({
      payload: bash('gh pr edit --repo b-at-neu/port --remove-label "needs human"'),
      operatorMessages: null,
    }),
    'deny',
  );

  // Adding, not removing, the needsHuman label is not a gate-clear attempt at
  // all — it is not guarded by this rule.
  check(
    'adding the needsHuman label is not guarded',
    gate({
      payload: bash('gh issue edit 5 --repo b-at-neu/port --add-label "needs human"'),
      operatorMessages: null,
    }),
    'allow',
  );

  // A subagent attempting the same gate clear is always denied, even with a
  // naming operator message — no stage may clear this gate at all.
  check(
    '#138 gate clear from a subagent is always denied',
    gate({
      payload: bash('gh pr edit 134 --repo b-at-neu/port --remove-label "needs human" --add-label "needs revision"', subagentPayload),
      operatorMessages: ['unblock #134'],
    }),
    'deny',
  );

  // gateClearAttempt itself: quote-aware and label-aware.
  {
    const noMatch = gateClearAttempt('gh pr edit 134 --add-label "needs human"', 'needs human');
    expect(!noMatch.isAttempt, 'guard-classifier', 'gateClearAttempt: adding the label was read as removing it');

    const match = gateClearAttempt('gh pr edit 134 --remove-label "needs human"', 'needs human');
    expect(
      match.isAttempt && match.numbers.length === 1 && match.numbers[0] === 134,
      'guard-classifier',
      () => `gateClearAttempt: expected isAttempt and numbers [134], got ${JSON.stringify(match)}`,
    );

    const batch = gateClearAttempt('gh issue edit 63 67 71 --remove-label "planning"', 'needs human');
    expect(!batch.isAttempt, 'guard-classifier', 'gateClearAttempt: a different label was read as a needsHuman clear');
    expect(batch.numbers.length === 3, 'guard-classifier', () => `gateClearAttempt: expected 3 numbers, got ${JSON.stringify(batch.numbers)}`);

    // #142/R1-C1 — hasNumbers is false for a branch-name identifier and for
    // no identifier at all, even though isAttempt is still true.
    const branchForm = gateClearAttempt('gh pr edit my-feature-branch --remove-label "needs human"', 'needs human');
    expect(
      branchForm.isAttempt && !branchForm.hasNumbers && branchForm.numbers.length === 0,
      'guard-classifier',
      () => `gateClearAttempt: expected isAttempt with hasNumbers false for a branch name, got ${JSON.stringify(branchForm)}`,
    );

    const noIdentifier = gateClearAttempt('gh pr edit --remove-label "needs human"', 'needs human');
    expect(
      noIdentifier.isAttempt && !noIdentifier.hasNumbers,
      'guard-classifier',
      () => `gateClearAttempt: expected isAttempt with hasNumbers false for no identifier, got ${JSON.stringify(noIdentifier)}`,
    );

    // #281 — a `gh pr edit` branch selector with a leading N- names N.
    const branchSelector = gateClearAttempt('gh pr edit 281-x --remove-label "needs human"', 'needs human');
    expect(
      branchSelector.isAttempt && branchSelector.hasNumbers && branchSelector.numbers.length === 1 && branchSelector.numbers[0] === 281,
      'guard-classifier',
      () => `gateClearAttempt: expected isAttempt with numbers [281] for a branch selector, got ${JSON.stringify(branchSelector)}`,
    );

    // #281 — `gh issue edit` gets no branch rung at all: an issue has no
    // branch selector, so a dash-shaped argument is never read as one.
    const issueEditBranchShaped = gateClearAttempt('gh issue edit 281-x --remove-label "needs human"', 'needs human');
    expect(
      issueEditBranchShaped.isAttempt && !issueEditBranchShaped.hasNumbers,
      'guard-classifier',
      () => `gateClearAttempt: expected isAttempt with hasNumbers false for 'gh issue edit 281-x', got ${JSON.stringify(issueEditBranchShaped)}`,
    );

    // #281 — no dash after the leading digits is not a branch selector.
    const noDash = gateClearAttempt('gh pr edit 281x-branch --remove-label "needs human"', 'needs human');
    expect(
      noDash.isAttempt && !noDash.hasNumbers,
      'guard-classifier',
      () => `gateClearAttempt: expected isAttempt with hasNumbers false for '281x-branch', got ${JSON.stringify(noDash)}`,
    );
  }

  // --- recentOperatorMessages / operatorNamed --------------------------------
  // guard(#138, #142): the gate-clear rail's own transcript-reading and naming primitives drifting from the gate rule above.
  {
    const jsonl = [
      JSON.stringify({ type: 'user', isMeta: true, message: { content: 'session start meta, ignore' } }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'some tool output, not a human message' }] },
      }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'reset #63 back to ready' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
      JSON.stringify({ type: 'user', message: { content: 'unblock #134' } }),
      '',
    ].join('\n');

    const messages = recentOperatorMessages(jsonl);
    expect(
      messages && messages.length === 2 && messages[0] === 'reset #63 back to ready' && messages[1] === 'unblock #134',
      'guard-classifier',
      () => `recentOperatorMessages: expected exactly the two real operator texts, newest last, got ${JSON.stringify(messages)}`,
    );

    const noUser = recentOperatorMessages(
      [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
        'not even json',
      ].join('\n'),
    );
    expect(noUser === null, 'guard-classifier', () => `recentOperatorMessages: expected null for no parseable user entry, got ${JSON.stringify(noUser)}`);

    expect(operatorNamed([134], null) === null, 'guard-classifier', 'operatorNamed: expected null (unverifiable) for messages: null');
    expect(operatorNamed([134], ['unblock #134']) === true, 'guard-classifier', 'operatorNamed: expected true when the message names #134');
    expect(operatorNamed([134], ['reset #63']) === false, 'guard-classifier', 'operatorNamed: expected false when no message names #134');

    // #142/R1-C1 — an empty numbers array must never be vacuously true.
    expect(operatorNamed([], ['unblock #134']) === false, 'guard-classifier', 'operatorNamed: expected false (not vacuously true) for an empty numbers array');

    // #142/R1-L1 — a coincidental numeric suffix on an unrelated word must
    // not stand in for naming the item; only a real word boundary counts.
    expect(
      operatorNamed([134], ['bumped to sprint134']) === false,
      'guard-classifier',
      'operatorNamed: expected false — "sprint134" merely ends in 134, it does not name it',
    );
    expect(
      operatorNamed([134], ['clear 134 please']) === true,
      'guard-classifier',
      'operatorNamed: expected true — a real standalone 134 still names it',
    );
  }

  // --- Approval arm (#288): audit-only, the revise #N route off `approved` ---
  // guard(#288): the hook denying an unnamed `approved` removal, which would
  // also block the cockpit's own automatic red-check withdrawal and stuck-
  // refresh escalation — both run from the same cockpit session with the
  // same command shape, and the hook cannot tell them apart from an
  // unprompted removal. The arm must therefore only ever add a 'gate-clear'
  // audit line on top of whatever the allowlist already decided, never
  // substitute a deny for it.
  {
    const approvedLabel = 'approved';
    const removeApproved = 'gh pr edit 300 --repo b-at-neu/port --remove-label "approved" --add-label "needs revision"';
    const approvalGate = makeDecide(decide, { matchers, sessionRequiredPaths: [], root, approvedLabel });

    // Named → gate-clear (allowed and logged as the audit record).
    check(
      '#288 approval arm — gate-clear when the operator names the pull request',
      approvalGate({
        payload: bash(removeApproved),
        operatorMessages: ['revise #300: rename the --limit flag to --max'],
      }),
      'gate-clear',
    );

    // A different item named → allow, never deny: an automatic withdrawal
    // (a red check, a stuck refresh loop) runs from this same cockpit
    // session and command shape, and must never be blocked by a message
    // that merely happens to name something else.
    check(
      '#288 approval arm — allow (never deny) when the operator named a different item',
      approvalGate({
        payload: bash(removeApproved),
        operatorMessages: ['unblock #134'],
      }),
      'allow',
    );

    // Unreadable transcript → allow, never deny — unverifiable is not
    // unauthorised, and this arm has no authority to block regardless.
    check(
      '#288 approval arm — allow with an unreadable transcript',
      approvalGate({
        payload: bash(removeApproved),
        operatorMessages: null,
      }),
      'allow',
    );

    // Subagent (e.g. revise-agent's own refresh-mode withdrawal) → allow —
    // this arm is inert for `who.isSubagent`, same as the gate rule.
    check(
      '#288 approval arm — allow for a subagent (refresh mode)',
      approvalGate({
        payload: bash(removeApproved, subagentPayload),
        operatorMessages: ['revise #300: rename the --limit flag to --max'],
      }),
      'allow',
    );

    // No number in the command (`gh` defaults to the current branch's PR) →
    // allow — nothing to check an operator message against, so this must
    // never fall through to operatorNamed's vacuously-true `[].every(...)`.
    check(
      '#288 approval arm — allow when the command names no item number',
      approvalGate({
        payload: bash('gh pr edit --repo b-at-neu/port --remove-label "approved"'),
        operatorMessages: ['revise #300: rename the --limit flag to --max'],
      }),
      'allow',
    );

    // Adding, not removing, 'approved' is not a gate-clear attempt at all.
    check(
      '#288 approval arm — adding the approved label is not guarded',
      approvalGate({
        payload: bash('gh pr edit 300 --repo b-at-neu/port --add-label "approved"'),
        operatorMessages: null,
      }),
      'allow',
    );

    // A looped named removal is still denied by the loop rule, which runs
    // before this arm — proving the rule order (gate → claim → install →
    // branch → loop → approval → allowlist) rather than merely asserting it.
    check(
      '#288 approval arm — a looped removal is still denied by the loop rule',
      approvalGate({
        payload: bash('for n in 300; do gh pr edit $n --repo b-at-neu/port --remove-label "approved"; done'),
        operatorMessages: ['revise #300: rename the --limit flag to --max'],
      }),
      'deny',
    );

    // approvedLabel omitted → the arm is inert, matching needsHumanLabel's
    // own pattern for a caller with no gate to guard.
    check(
      '#288 approval arm — inert when approvedLabel is omitted',
      decide({
        payload: bash(removeApproved),
        matchers,
        sessionRequiredPaths: [],
        root,
        operatorMessages: ['revise #300: rename the --limit flag to --max'],
      }),
      'allow',
    );
  }
}
