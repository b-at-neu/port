import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, pipelineDocsText, pipelineSkillText } from '../lib/files.ts';
import { resolveMatchers, subagentPayload, plainPayload, operatorWorktreePayload, makeCheck } from '../lib/guard-fixtures.ts';
import type { Reporter } from '../lib/report.ts';

const PLAN_GATE_KEYS = ['planReview', 'planApproved', 'planChangesRequested'];
const PLAN_GATE_LABELS = ['plan review', 'plan approved', 'plan changes requested'];

export default async function ({ fail, ok, note }: Reporter) {
  const { decide } = await import(pathToFileURL(join(root, 'plugins/port/hooks/lib/guard-rules.mjs')).href);
  const { classifyGateClaim } = await import(pathToFileURL(join(root, 'plugins/port/hooks/lib/claim-rules.mjs')).href);
  const { labelEditAttempt } = await import(pathToFileURL(join(root, 'plugins/port/hooks/lib/command-rules.mjs')).href);

  const matchers = resolveMatchers(fail);
  const check = makeCheck(fail, ok);

  // --- classifyGateClaim: the three verdicts, mirroring the desktop app's readGateClaim ----
  // guard(#206): a claim classifier that drifts from the desktop app's own
  // reader would let the cockpit and the app disagree about whether the
  // gate is claimed — the exact split-brain #206 exists to close.
  {
    const absent = classifyGateClaim(false, '', 'b-at-neu/port');
    if (absent.state !== 'absent') fail('gate-claim-classifier', `expected 'absent' for a missing file, got ${JSON.stringify(absent)}`);
    else ok();

    const held = classifyGateClaim(
      true,
      JSON.stringify({ repo: 'b-at-neu/port', owner: 'port-desktop', scopes: ['plan-gate'], claimedAt: '2026-09-05T14:02:11Z' }),
      'b-at-neu/port',
    );
    if (held.state !== 'held' || held.owner !== 'port-desktop' || !held.scopes.includes('plan-gate')) {
      fail('gate-claim-classifier', `expected a 'held' verdict naming plan-gate, got ${JSON.stringify(held)}`);
    } else {
      ok();
    }

    // A repo mismatch reads as absent — a positive determination, not ambiguity.
    const otherRepo = classifyGateClaim(
      true,
      JSON.stringify({ repo: 'other/repo', owner: 'x', scopes: ['plan-gate'], claimedAt: '2026-09-05T14:02:11Z' }),
      'b-at-neu/port',
    );
    if (otherRepo.state !== 'absent') fail('gate-claim-classifier', `expected 'absent' for a claim naming a different repo, got ${JSON.stringify(otherRepo)}`);
    else ok();

    // Unparseable JSON, not an object, and missing owner/claimedAt all read as unreadable.
    const badJson = classifyGateClaim(true, 'not json', 'b-at-neu/port');
    if (badJson.state !== 'unreadable') fail('gate-claim-classifier', `expected 'unreadable' for bad JSON, got ${JSON.stringify(badJson)}`);
    else ok();

    const missingFields = classifyGateClaim(true, JSON.stringify({ repo: 'b-at-neu/port', scopes: ['plan-gate'] }), 'b-at-neu/port');
    if (missingFields.state !== 'unreadable') fail('gate-claim-classifier', `expected 'unreadable' for a claim missing owner/claimedAt, got ${JSON.stringify(missingFields)}`);
    else ok();

    // An unrecognized scope is reported, never denied on and never dropped silently.
    const unknownScope = classifyGateClaim(
      true,
      JSON.stringify({ repo: 'b-at-neu/port', owner: 'x', scopes: ['plan-gate', 'something-else'], claimedAt: '2026-09-05T14:02:11Z' }),
      'b-at-neu/port',
    );
    if (!unknownScope.scopes.includes('plan-gate') || !unknownScope.unknownScopes.includes('something-else')) {
      fail('gate-claim-classifier', `expected plan-gate recognized and 'something-else' reported unknown, got ${JSON.stringify(unknownScope)}`);
    } else {
      ok();
    }

    // A held claim naming only some other scope never claims plan-gate.
    const otherScopeOnly = classifyGateClaim(
      true,
      JSON.stringify({ repo: 'b-at-neu/port', owner: 'x', scopes: ['something-else'], claimedAt: '2026-09-05T14:02:11Z' }),
      'b-at-neu/port',
    );
    if (otherScopeOnly.scopes.includes('plan-gate')) {
      fail('gate-claim-classifier', `expected plan-gate NOT claimed when scopes names only an unrecognized entry, got ${JSON.stringify(otherScopeOnly)}`);
    } else {
      ok();
    }
  }

  // --- labelEditAttempt: both directions, unlike gateClearAttempt's remove-only ------------
  {
    const add = labelEditAttempt('gh issue edit 148 --add-label "plan approved"', PLAN_GATE_LABELS);
    if (!add.isAttempt || !add.matched.includes('plan approved')) {
      fail('gate-claim-classifier', `labelEditAttempt: expected a match on --add-label, got ${JSON.stringify(add)}`);
    } else {
      ok();
    }

    const remove = labelEditAttempt('gh issue edit 148 --remove-label "plan review"', PLAN_GATE_LABELS);
    if (!remove.isAttempt || !remove.matched.includes('plan review')) {
      fail('gate-claim-classifier', `labelEditAttempt: expected a match on --remove-label, got ${JSON.stringify(remove)}`);
    } else {
      ok();
    }

    // autoPlan is deliberately outside the set — adding it is never a claim-rule match.
    const autoPlan = labelEditAttempt('gh issue edit 148 --add-label "auto plan"', PLAN_GATE_LABELS);
    if (autoPlan.isAttempt) fail('gate-claim-classifier', `labelEditAttempt: "auto plan" must never match the plan-gate label set, got ${JSON.stringify(autoPlan)}`);
    else ok();

    // A label name quoted inside a -b body must never trip the rule.
    const quotedInBody = labelEditAttempt('gh issue comment 148 -b "moving this to plan approved shortly"', PLAN_GATE_LABELS);
    if (quotedInBody.isAttempt) fail('gate-claim-classifier', 'labelEditAttempt: a label name quoted inside -b must not match');
    else ok();
  }

  // --- Claim rule, Bash arm ------------------------------------------------------------------
  // guard(#206): the cockpit (or anyone else, cockpit-shaped or not) adding
  // or removing a plan-gate label while an external claim holds it.
  const held = { state: 'held', owner: 'port-desktop', scopes: ['plan-gate'], unknownScopes: [], claimedAt: '2026-09-05T14:02:11Z' };
  const unreadable = { state: 'unreadable', message: "missing 'owner' or 'claimedAt'" };
  const otherScope = { state: 'held', owner: 'port-desktop', scopes: [], unknownScopes: ['something-else'], claimedAt: '2026-09-05T14:02:11Z' };
  const absent = { state: 'absent' };

  check(
    'held plan-gate claim denies --add-label "plan approved" from a plain (cockpit-shaped) session',
    decide({
      payload: plainPayload({ tool_input: { command: 'gh issue edit 148 --repo b-at-neu/port --remove-label "plan review" --add-label "plan approved"' } }),
      matchers,
      sessionRequiredPaths: [],
      root,
      planGateClaim: held,
      planGateLabels: PLAN_GATE_LABELS,
    }),
    'deny',
  );

  {
    // The identical command from a subagent is never denied by this rule —
    // plan-agent/impl-agent write these same labels at handoff.
    const result = decide({
      payload: subagentPayload({ tool_input: { command: 'gh issue edit 148 --repo b-at-neu/port --remove-label "plan review" --add-label "plan approved"' } }),
      matchers,
      sessionRequiredPaths: [],
      root,
      planGateClaim: held,
      planGateLabels: PLAN_GATE_LABELS,
    });
    if (result.decision === 'deny') {
      fail('gate-claim-rule', `claim rule must exempt a subagent (plan-agent/impl-agent write these labels at handoff), got 'deny' (${result.reason})`);
    } else {
      ok();
    }
  }

  {
    // The identical command from an impl-<n> operator worktree is exempt too.
    const result = decide({
      payload: operatorWorktreePayload({ tool_input: { command: 'gh issue edit 148 --repo b-at-neu/port --remove-label "plan review" --add-label "plan approved"' } }),
      matchers,
      sessionRequiredPaths: [],
      root,
      planGateClaim: held,
      planGateLabels: PLAN_GATE_LABELS,
    });
    if (result.decision === 'deny') {
      fail('gate-claim-rule', `claim rule must exempt an /port:implement impl-<n> worktree, got 'deny' (${result.reason})`);
    } else {
      ok();
    }
  }

  check(
    'no claim (absent) never denies a plan-gate label edit',
    decide({
      payload: plainPayload({ tool_input: { command: 'gh issue edit 148 --repo b-at-neu/port --remove-label "plan review" --add-label "plan approved"' } }),
      matchers,
      sessionRequiredPaths: [],
      root,
      planGateClaim: absent,
      planGateLabels: PLAN_GATE_LABELS,
    }),
    'allow',
  );

  check(
    'an unreadable claim denies exactly as a held one does',
    decide({
      payload: plainPayload({ tool_input: { command: 'gh pr edit 134 --repo b-at-neu/port --remove-label "plan review"' } }),
      matchers,
      sessionRequiredPaths: [],
      root,
      planGateClaim: unreadable,
      planGateLabels: PLAN_GATE_LABELS,
    }),
    'deny',
  );

  check(
    'a held claim naming only an unrecognized scope never denies a plan-gate label edit',
    decide({
      payload: plainPayload({ tool_input: { command: 'gh issue edit 148 --repo b-at-neu/port --add-label "plan approved"' } }),
      matchers,
      sessionRequiredPaths: [],
      root,
      planGateClaim: otherScope,
      planGateLabels: PLAN_GATE_LABELS,
    }),
    'allow',
  );

  check(
    'autoPlan is deliberately outside the claimed set — adding it is never denied by this rule',
    decide({
      payload: plainPayload({ tool_input: { command: 'gh issue edit 148 --repo b-at-neu/port --add-label "auto plan"' } }),
      matchers,
      sessionRequiredPaths: [],
      root,
      planGateClaim: held,
      planGateLabels: PLAN_GATE_LABELS,
    }),
    'allow',
  );

  check(
    'the label name quoted inside a -b body never trips the rule',
    decide({
      payload: plainPayload({ tool_input: { command: 'gh issue comment 148 --repo b-at-neu/port -b "moving this to plan approved shortly"' } }),
      matchers,
      sessionRequiredPaths: [],
      root,
      planGateClaim: held,
      planGateLabels: PLAN_GATE_LABELS,
    }),
    'allow',
  );

  // --- Claim rule, write-tool arm -------------------------------------------------------------
  // guard(#206, #138): a machine releasing its own constraint — the same
  // shape #138 already named — by writing over the claim file directly. No
  // exemption at all, unlike every other rule above: this one fires for a
  // subagent, a plain session, and an impl-<n> operator worktree alike.
  const claimFilePath = join(root, '.agents', 'gate-claim.json');

  for (const [label, payload] of [
    ['subagent', subagentPayload({ tool_name: 'Write', tool_input: { file_path: claimFilePath, content: '{}' } })],
    ['plain session', plainPayload({ tool_name: 'Write', tool_input: { file_path: claimFilePath, content: '{}' } })],
    ['impl-<n> operator worktree', operatorWorktreePayload({ tool_name: 'Edit', tool_input: { file_path: claimFilePath, old_string: 'a', new_string: 'b' } })],
  ]) {
    check(`write to the claim file itself is denied — ${label}`, decide({ payload, matchers, sessionRequiredPaths: [], root, claimFilePath }), 'deny');
  }

  {
    // A write to .agents/denials.log — a different path — is unaffected by
    // the claim rule; with no sessionRequiredPaths configured here, the
    // ordinary write-tool arm allows it, so 'allow' is the proof this rule
    // matched on path equality, not merely "any write, anywhere."
    const result = decide({
      payload: subagentPayload({ tool_name: 'Write', tool_input: { file_path: join(root, '.agents', 'denials.log'), content: '' } }),
      matchers,
      sessionRequiredPaths: [],
      root,
      claimFilePath,
    });
    if (result.decision !== 'allow') {
      fail('gate-claim-rule', `a write to .agents/denials.log must not be denied by the claim rule, got ${JSON.stringify(result)}`);
    } else {
      ok();
    }
  }

  // --- End-to-end wiring: the real agent-guard.mjs against a temp fixture ---------------------
  // guard(#206): the classifier's own import cannot see the hook's own claim
  // read/resolve wiring (config.repo, config.labels, the base-root path).
  {
    const hookPath = join(root, 'plugins/port/hooks/agent-guard.mjs');
    const fixture = mkdtempSync(join(tmpdir(), 'port-guard-claim-'));
    try {
      mkdirSync(join(fixture, '.claude'), { recursive: true });
      mkdirSync(join(fixture, '.agents'), { recursive: true });
      writeFileSync(
        join(fixture, '.claude', 'port.config.json'),
        JSON.stringify({ repo: 'example/widgets', sessionRequiredPaths: ['CLAUDE.md', '.claude/**'], labels: {} }),
      );
      writeFileSync(join(fixture, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(gh *)'] } }));
      writeFileSync(
        join(fixture, '.agents', 'gate-claim.json'),
        JSON.stringify({ repo: 'example/widgets', owner: 'port-desktop', scopes: ['plan-gate'], claimedAt: '2026-09-05T14:02:11Z' }),
      );

      const run = (payload: any) =>
        execFileSync(process.execPath, [hookPath], {
          cwd: fixture,
          input: JSON.stringify(payload),
          stdio: ['pipe', 'pipe', 'ignore'],
          encoding: 'utf8',
        });

      const stdout = run({
        cwd: fixture,
        session_id: 'sess-claim-1',
        tool_name: 'Bash',
        tool_input: { command: 'gh issue edit 148 --repo example/widgets --remove-label "plan review" --add-label "plan approved"' },
      });
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        fail('gate-claim-wiring', `expected JSON deny output against a held claim, got ${JSON.stringify(stdout)}`);
      }
      if (parsed && parsed.hookSpecificOutput?.permissionDecision !== 'deny') {
        fail('gate-claim-wiring', `expected permissionDecision 'deny' against a held claim, got ${JSON.stringify(parsed)}`);
      } else {
        ok();
      }

      // A command that does not touch a plan-gate label proceeds normally,
      // even with the claim held — proof the claim read is scoped, not a
      // blanket cockpit freeze.
      const untouched = run({
        cwd: fixture,
        session_id: 'sess-claim-2',
        tool_name: 'Bash',
        tool_input: { command: 'gh issue edit 148 --repo example/widgets --add-label "ready"' },
      });
      if (untouched.trim() !== '') fail('gate-claim-wiring', `expected no deny for a non-plan-gate label edit, got ${JSON.stringify(untouched)}`);
      else ok();
    } catch (e: any) {
      if (e.status !== undefined) fail('gate-claim-wiring', `hook exited non-zero: ${e.message}`);
      else throw e;
    } finally {
      rmSync(fixture, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  // --- Doc pins ---------------------------------------------------------------------------
  // guard(#206): the hook's plan-gate key set, PIPELINE.md's claim section,
  // and docs/COORDINATION.md's own claim-contract prose drifting apart —
  // each names the same three label keys, and a fourth added to one without
  // the others would silently narrow or widen what the hook actually denies.
  {
    const hookText = readFileSync(join(root, 'plugins/port/hooks/agent-guard.mjs'), 'utf8');
    const planGateLabelsBlock = /const planGateLabels = \[([\s\S]*?)\];/.exec(hookText)?.[1] ?? '';
    const hookKeys = [...planGateLabelsBlock.matchAll(/config\?\.labels\?\.(\w+)/g)].map((m) => m[1]);
    const hookKeySet = new Set(hookKeys);
    const expected = new Set(PLAN_GATE_KEYS);
    const missingFromHook = PLAN_GATE_KEYS.filter((k) => !hookKeySet.has(k));
    const extraInHook = hookKeys.filter((k) => !expected.has(k));
    if (missingFromHook.length > 0 || extraInHook.length > 0) {
      fail(
        'gate-claim-doc-pin',
        `agent-guard.mjs's plan-gate key reads must be exactly ${PLAN_GATE_KEYS.join('/')}, got ${JSON.stringify(hookKeys)}`,
      );
    } else {
      ok();
    }

    const docsText = pipelineDocsText();
    const claimSection = /### External gate claim([\s\S]*?)(?:\n## |\n### |$)/.exec(docsText)?.[1] ?? '';
    if (!claimSection) {
      fail('gate-claim-doc-pin', 'PIPELINE.md is missing an "External gate claim" section');
    } else {
      // The doc must name every hook key. `autoPlan` also appears here,
      // deliberately, as the documented exclusion from the set — so this
      // checks membership, not exact set equality, in this direction.
      const docKeys = new Set([...claimSection.matchAll(/<labels\.(\w+)>/g)].map((m) => m[1]));
      const missingFromDoc = PLAN_GATE_KEYS.filter((k) => !docKeys.has(k));
      if (missingFromDoc.length > 0) {
        fail('gate-claim-doc-pin', `PIPELINE.md's "External gate claim" section does not name <labels.${missingFromDoc.join('>, <labels.')}>`);
      } else {
        ok();
      }
      if (!claimSection.includes('.agents/gate-claim.json')) {
        fail('gate-claim-doc-pin', 'PIPELINE.md\'s "External gate claim" section does not name .agents/gate-claim.json');
      } else {
        ok();
      }
    }

    const coordinationText = readFileSync(join(root, 'docs/COORDINATION.md'), 'utf8');
    const missingFromCoordination = PLAN_GATE_KEYS.filter((k) => !coordinationText.includes(k));
    if (missingFromCoordination.length > 0) {
      fail('gate-claim-doc-pin', `docs/COORDINATION.md no longer names ${missingFromCoordination.join(', ')} — the claim-contract keys drifted`);
    } else {
      ok();
    }

    // The stand-down precondition and copy are literal, checkable phrases
    // (docs/ENGINEERING.md §7), not "never do X" prose — pinned in the
    // cockpit's own companion files.
    const skillText = pipelineSkillText();
    if (!skillText.includes("this tick's claim verdict is")) {
      fail('gate-claim-doc-pin', 'the pipeline skill is missing the plan-review precondition phrase ("this tick\'s claim verdict is")');
    } else {
      ok();
    }
    if (!skillText.includes('Plan gate claimed by')) {
      fail('gate-claim-doc-pin', 'the pipeline skill is missing the stand-down UX state ("Plan gate claimed by")');
    } else {
      ok();
    }
    if (!skillText.includes('.agents/gate-claim.json')) {
      fail('gate-claim-doc-pin', 'the pipeline skill never names .agents/gate-claim.json');
    } else {
      ok();
    }

    // "Cockpit rules" now names five rules — a sixth cannot land without the
    // prose count moving with it, and this pin is what would catch a fourth
    // silently added to the four-rule count that predates this ticket.
    const cockpitRulesSection = /Cockpit rules\.([\s\S]*?)(?=\n### |\n## )/.exec(docsText)?.[1] ?? '';
    const bulletCount = [...cockpitRulesSection.matchAll(/\n- \*\*/g)].length;
    if (!/\bfive\b/.test(cockpitRulesSection)) {
      fail('gate-claim-doc-pin', 'PIPELINE.md\'s "Cockpit rules" paragraph no longer states "five"');
    } else if (bulletCount !== 5) {
      fail('gate-claim-doc-pin', `PIPELINE.md's "Cockpit rules" list has ${bulletCount} bullets, expected 5`);
    } else {
      ok();
    }
  }

  note('gate-claim: classifier, both decide() arms, end-to-end wiring, and doc pins');
}
