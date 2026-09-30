import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from '../lib/files.ts';
import { resolveMatchers, subagentPayload, plainPayload, makeCheck } from '../lib/guard-fixtures.ts';
import type { Reporter } from '../lib/report.ts';

export default async function ({ fail, ok }: Reporter) {
  const { decide, recentOperatorMessages, operatorNamed } =
    await import(pathToFileURL(join(root, 'plugins/port/hooks/lib/guard-rules.mjs')).href);
  const { gateClearAttempt } = await import(pathToFileURL(join(root, 'plugins/port/hooks/lib/command-rules.mjs')).href);

  const matchers = resolveMatchers(fail);
  const check = makeCheck(fail, ok);

  // --- Cockpit rules: gate rule ------------------------------------------------
  // guard(#138, #142): the cockpit clearing its own needs-human gate under throughput pressure, unverified.
  const needsHumanLabel = 'needs human';

  // A gate-clear attempt with operator messages naming a different item →
  // denied.
  check(
    '#138 gate clear denied — operator named a different item',
    decide({
      payload: plainPayload({
        tool_input: { command: 'gh pr edit 134 --repo b-at-neu/port --remove-label "needs human" --add-label "needs revision"' },
      }),
      matchers,
      sessionRequiredPaths: [],
      root,
      needsHumanLabel,
      operatorMessages: ['reset #63 back to ready', 'thanks, thats everything for now'],
    }),
    'deny',
  );

  // Same command, with a message naming pull request 134 → gate-clear
  // (allowed and logged as the audit record, never a plain 'allow').
  check(
    '#138 gate clear allowed — operator named the item',
    decide({
      payload: plainPayload({
        tool_input: { command: 'gh pr edit 134 --repo b-at-neu/port --remove-label "needs human" --add-label "needs revision"' },
      }),
      matchers,
      sessionRequiredPaths: [],
      root,
      needsHumanLabel,
      operatorMessages: ['unblock #134'],
    }),
    'gate-clear',
  );

  // Same command, transcript unreadable (operatorMessages: null) →
  // unverifiable, not unauthorised — gate-clear, never a silent deny.
  check(
    '#138 gate clear with an unreadable transcript',
    decide({
      payload: plainPayload({
        tool_input: { command: 'gh pr edit 134 --repo b-at-neu/port --remove-label "needs human" --add-label "needs revision"' },
      }),
      matchers,
      sessionRequiredPaths: [],
      root,
      needsHumanLabel,
      operatorMessages: null,
    }),
    'gate-clear',
  );

  // #142/R1-C1 — a gate-clear attempt with no bare digit and no issues/pull
  // URL (a branch-name identifier, which `gh` accepts) must be denied
  // outright, never fall through to operatorNamed's vacuously-true
  // `[].every(...)` on an empty numbers array. Even an operator message that
  // would otherwise satisfy some *other* item must not let this through —
  // there is nothing here for it to have named.
  check(
    '#142 gate clear denied — command names no item number (branch form)',
    decide({
      payload: plainPayload({
        tool_input: { command: 'gh pr edit 139-guard-cockpit-loop-and-gate-rules --repo b-at-neu/port --remove-label "needs human"' },
      }),
      matchers,
      sessionRequiredPaths: [],
      root,
      needsHumanLabel,
      operatorMessages: ['unblock #134'],
    }),
    'deny',
  );

  // Same bug, the no-identifier-at-all form (`gh` defaults to the current
  // branch's PR).
  check(
    '#142 gate clear denied — command names no item number (no identifier)',
    decide({
      payload: plainPayload({
        tool_input: { command: 'gh pr edit --repo b-at-neu/port --remove-label "needs human"' },
      }),
      matchers,
      sessionRequiredPaths: [],
      root,
      needsHumanLabel,
      operatorMessages: null,
    }),
    'deny',
  );

  // Adding, not removing, the needsHuman label is not a gate-clear attempt at
  // all — it is not guarded by this rule.
  check(
    'adding the needsHuman label is not guarded',
    decide({
      payload: plainPayload({
        tool_input: { command: 'gh issue edit 5 --repo b-at-neu/port --add-label "needs human"' },
      }),
      matchers,
      sessionRequiredPaths: [],
      root,
      needsHumanLabel,
      operatorMessages: null,
    }),
    'allow',
  );

  // A subagent attempting the same gate clear is always denied, even with a
  // naming operator message — no stage may clear this gate at all.
  check(
    '#138 gate clear from a subagent is always denied',
    decide({
      payload: subagentPayload({
        tool_input: { command: 'gh pr edit 134 --repo b-at-neu/port --remove-label "needs human" --add-label "needs revision"' },
      }),
      matchers,
      sessionRequiredPaths: [],
      root,
      needsHumanLabel,
      operatorMessages: ['unblock #134'],
    }),
    'deny',
  );

  // gateClearAttempt itself: quote-aware and label-aware.
  {
    const noMatch = gateClearAttempt('gh pr edit 134 --add-label "needs human"', 'needs human');
    if (noMatch.isAttempt) fail('guard-classifier', 'gateClearAttempt: adding the label was read as removing it');
    else ok();

    const match = gateClearAttempt('gh pr edit 134 --remove-label "needs human"', 'needs human');
    if (!match.isAttempt || match.numbers.length !== 1 || match.numbers[0] !== 134) {
      fail('guard-classifier', `gateClearAttempt: expected isAttempt and numbers [134], got ${JSON.stringify(match)}`);
    } else {
      ok();
    }

    const batch = gateClearAttempt('gh issue edit 63 67 71 --remove-label "planning"', 'needs human');
    if (batch.isAttempt) fail('guard-classifier', 'gateClearAttempt: a different label was read as a needsHuman clear');
    else if (batch.numbers.length !== 3) fail('guard-classifier', `gateClearAttempt: expected 3 numbers, got ${JSON.stringify(batch.numbers)}`);
    else ok();

    // #142/R1-C1 — hasNumbers is false for a branch-name identifier and for
    // no identifier at all, even though isAttempt is still true.
    const branchForm = gateClearAttempt('gh pr edit my-feature-branch --remove-label "needs human"', 'needs human');
    if (!branchForm.isAttempt || branchForm.hasNumbers || branchForm.numbers.length !== 0) {
      fail('guard-classifier', `gateClearAttempt: expected isAttempt with hasNumbers false for a branch name, got ${JSON.stringify(branchForm)}`);
    } else {
      ok();
    }

    const noIdentifier = gateClearAttempt('gh pr edit --remove-label "needs human"', 'needs human');
    if (!noIdentifier.isAttempt || noIdentifier.hasNumbers) {
      fail('guard-classifier', `gateClearAttempt: expected isAttempt with hasNumbers false for no identifier, got ${JSON.stringify(noIdentifier)}`);
    } else {
      ok();
    }
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
    if (!messages || messages.length !== 2 || messages[0] !== 'reset #63 back to ready' || messages[1] !== 'unblock #134') {
      fail('guard-classifier', `recentOperatorMessages: expected exactly the two real operator texts, newest last, got ${JSON.stringify(messages)}`);
    } else {
      ok();
    }

    const noUser = recentOperatorMessages(
      [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
        'not even json',
      ].join('\n'),
    );
    if (noUser !== null) fail('guard-classifier', `recentOperatorMessages: expected null for no parseable user entry, got ${JSON.stringify(noUser)}`);
    else ok();

    if (operatorNamed([134], null) !== null) fail('guard-classifier', 'operatorNamed: expected null (unverifiable) for messages: null');
    else ok();
    if (operatorNamed([134], ['unblock #134']) !== true) fail('guard-classifier', 'operatorNamed: expected true when the message names #134');
    else ok();
    if (operatorNamed([134], ['reset #63']) !== false) fail('guard-classifier', 'operatorNamed: expected false when no message names #134');
    else ok();

    // #142/R1-C1 — an empty numbers array must never be vacuously true.
    if (operatorNamed([], ['unblock #134']) !== false) fail('guard-classifier', 'operatorNamed: expected false (not vacuously true) for an empty numbers array');
    else ok();

    // #142/R1-L1 — a coincidental numeric suffix on an unrelated word must
    // not stand in for naming the item; only a real word boundary counts.
    if (operatorNamed([134], ['bumped to sprint134']) !== false) {
      fail('guard-classifier', 'operatorNamed: expected false — "sprint134" merely ends in 134, it does not name it');
    } else {
      ok();
    }
    if (operatorNamed([134], ['clear 134 please']) !== true) {
      fail('guard-classifier', 'operatorNamed: expected true — a real standalone 134 still names it');
    } else {
      ok();
    }
  }
}
