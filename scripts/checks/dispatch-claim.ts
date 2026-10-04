import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, pipelineDocsText } from '../lib/files.ts';
import { makeCheck, plainPayload, resolveMatchers, subagentPayload } from '../lib/guard-fixtures.ts';
import type { Reporter } from '../lib/report.ts';

export default async function ({ fail, ok, note }: Reporter) {
  const { decide } = await import(pathToFileURL(join(root, 'plugins/port/hooks/lib/guard-rules.mjs')).href);
  const { dispatchDenial } = await import(pathToFileURL(join(root, 'plugins/port/hooks/lib/claim-rules.mjs')).href);

  const matchers = resolveMatchers(fail);
  const check = makeCheck(fail, ok);

  const held = { state: 'held', owner: 'port-desktop', scopes: ['dispatch'], unknownScopes: [], claimedAt: '2026-09-05T14:02:11Z' };
  const unreadable = { state: 'unreadable', message: "missing 'owner' or 'claimedAt'" };
  const absent = { state: 'absent' };
  const planGateOnly = { state: 'held', owner: 'port-desktop', scopes: ['plan-gate'], unknownScopes: [], claimedAt: '2026-09-05T14:02:11Z' };

  // --- dispatchDenial — the Agent-tool arm, unit cases ------------------------
  // guard(#265): a cockpit session's Agent call must be denied exactly when
  // the claim holds 'dispatch' (or is unreadable) and the caller is
  // established as a cockpit session — never otherwise.
  {
    const cockpitWho = { isSubagent: false, isOperatorWorktree: false, isManagedWorktree: false, agent: null, signal: null };
    const subagentWho = { isSubagent: true, isOperatorWorktree: false, isManagedWorktree: true, agent: 'impl-agent', signal: 'agent_type' };

    const deniedHeld = dispatchDenial({ toolName: 'Agent', who: cockpitWho, isCockpitSession: true, claim: held });
    if (deniedHeld?.decision !== 'deny') fail('dispatch-claim', `expected a held 'dispatch' claim to deny a cockpit session's Agent call, got ${JSON.stringify(deniedHeld)}`);
    else ok();

    const deniedUnreadable = dispatchDenial({ toolName: 'Agent', who: cockpitWho, isCockpitSession: true, claim: unreadable });
    if (deniedUnreadable?.decision !== 'deny') fail('dispatch-claim', `expected an unreadable claim to deny exactly as a held one does, got ${JSON.stringify(deniedUnreadable)}`);
    else ok();

    const allowedAbsent = dispatchDenial({ toolName: 'Agent', who: cockpitWho, isCockpitSession: true, claim: absent });
    if (allowedAbsent !== null) fail('dispatch-claim', `expected an absent claim to never deny, got ${JSON.stringify(allowedAbsent)}`);
    else ok();

    const allowedPlanGateOnly = dispatchDenial({ toolName: 'Agent', who: cockpitWho, isCockpitSession: true, claim: planGateOnly });
    if (allowedPlanGateOnly !== null) fail('dispatch-claim', `expected a claim holding only 'plan-gate' to never deny an Agent call, got ${JSON.stringify(allowedPlanGateOnly)}`);
    else ok();

    const allowedSubagent = dispatchDenial({ toolName: 'Agent', who: subagentWho, isCockpitSession: true, claim: held });
    if (allowedSubagent !== null) fail('dispatch-claim', `expected a subagent to be exempt — stage agents already declare disallowedTools: Agent — got ${JSON.stringify(allowedSubagent)}`);
    else ok();

    const allowedNotCockpit = dispatchDenial({ toolName: 'Agent', who: cockpitWho, isCockpitSession: false, claim: held });
    if (allowedNotCockpit !== null) fail('dispatch-claim', `expected an ordinary (non-cockpit) session to never be denied, got ${JSON.stringify(allowedNotCockpit)}`);
    else ok();

    const allowedUnverifiable = dispatchDenial({ toolName: 'Agent', who: cockpitWho, isCockpitSession: null, claim: held });
    if (allowedUnverifiable !== null) fail('dispatch-claim', `expected an unreadable transcript (isCockpitSession: null) to fail open, got ${JSON.stringify(allowedUnverifiable)}`);
    else ok();
  }

  // --- decide()'s own Agent arm ------------------------------------------------
  // guard(#265): the pure classifier wires dispatchDenial correctly, in both
  // directions, through the same decide() every other tool call goes through.
  check(
    'a held dispatch claim denies an Agent call from a cockpit-shaped session',
    decide({ payload: plainPayload({ tool_name: 'Agent', tool_input: { description: 'impl #52', subagent_type: 'port:impl-agent' } }), matchers, sessionRequiredPaths: [], root, isCockpitSession: true, dispatchClaim: held }),
    'deny',
  );

  check(
    'the identical Agent call from a subagent is never denied by this rule',
    decide({ payload: subagentPayload({ tool_name: 'Agent', tool_input: { description: 'impl #52', subagent_type: 'port:impl-agent' } }), matchers, sessionRequiredPaths: [], root, isCockpitSession: true, dispatchClaim: held }),
    'allow',
  );

  check(
    'no claim (absent) never denies an Agent call',
    decide({ payload: plainPayload({ tool_name: 'Agent', tool_input: { description: 'impl #52', subagent_type: 'port:impl-agent' } }), matchers, sessionRequiredPaths: [], root, isCockpitSession: true, dispatchClaim: absent }),
    'allow',
  );

  // --- hooks.json names an Agent matcher --------------------------------------
  // guard(#265): the dispatch rule is only reachable if the hook actually
  // fires for the Agent tool — a classifier with nothing wiring it to the
  // tool call is dead code.
  {
    const hooksJson = JSON.parse(readFileSync(join(root, 'plugins/port/hooks/hooks.json'), 'utf8'));
    const matcherNames = (hooksJson.hooks?.PreToolUse ?? []).map((entry: { matcher?: string }) => entry.matcher);
    if (!matcherNames.includes('Agent')) {
      fail('dispatch-claim', `hooks.json's PreToolUse matchers (${JSON.stringify(matcherNames)}) do not include 'Agent'`);
    } else {
      ok();
    }
  }

  // --- End-to-end wiring: the real agent-guard.mjs against a temp fixture -----
  // guard(#265): the classifier's own import cannot see the hook's own
  // dispatch-claim read/resolve wiring for the Agent tool specifically.
  {
    const hookPath = join(root, 'plugins/port/hooks/agent-guard.mjs');
    const fixture = mkdtempSync(join(tmpdir(), 'port-guard-dispatch-'));
    try {
      mkdirSync(join(fixture, '.claude'), { recursive: true });
      mkdirSync(join(fixture, '.agents'), { recursive: true });
      writeFileSync(join(fixture, '.claude', 'port.config.json'), JSON.stringify({ repo: 'example/widgets', sessionRequiredPaths: ['CLAUDE.md', '.claude/**'], labels: {} }));
      writeFileSync(join(fixture, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(gh *)'] } }));
      writeFileSync(join(fixture, '.agents', 'gate-claim.json'), JSON.stringify({ repo: 'example/widgets', owner: 'port-desktop', scopes: ['dispatch'], claimedAt: '2026-09-05T14:02:11Z' }));

      const transcriptPath = join(fixture, 'cockpit-transcript.jsonl');
      writeFileSync(transcriptPath, `${JSON.stringify({ type: 'user', message: { content: '<command-name>/port:pipeline</command-name>' } })}\n`);

      const run = (payload: Record<string, unknown>) =>
        execFileSync(process.execPath, [hookPath], { cwd: fixture, input: JSON.stringify(payload), stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf8' });

      const stdout = run({ cwd: fixture, session_id: 'sess-dispatch-1', tool_name: 'Agent', transcript_path: transcriptPath, tool_input: { description: 'impl #52', subagent_type: 'port:impl-agent' } });
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        fail('dispatch-claim-wiring', `expected JSON deny output against a held dispatch claim and a cockpit transcript, got ${JSON.stringify(stdout)}`);
      }
      if (parsed && parsed.hookSpecificOutput?.permissionDecision !== 'deny') {
        fail('dispatch-claim-wiring', `expected permissionDecision 'deny' against a held dispatch claim from a cockpit session, got ${JSON.stringify(parsed)}`);
      } else {
        ok();
      }

      // A plain (non-cockpit) session's transcript never trips this rule —
      // proof the read is scoped to an established cockpit, not every caller.
      const plainTranscriptPath = join(fixture, 'plain-transcript.jsonl');
      writeFileSync(plainTranscriptPath, `${JSON.stringify({ type: 'user', message: { content: 'hello' } })}\n`);
      const allowed = run({ cwd: fixture, session_id: 'sess-dispatch-2', tool_name: 'Agent', transcript_path: plainTranscriptPath, tool_input: { description: 'impl #52', subagent_type: 'port:impl-agent' } });
      if (allowed.trim() !== '') fail('dispatch-claim-wiring', `expected no deny for a non-cockpit session, got ${JSON.stringify(allowed)}`);
      else ok();
    } catch (e: any) {
      if (e.status !== undefined) fail('dispatch-claim-wiring', `hook exited non-zero: ${e.message}`);
      else throw e;
    } finally {
      rmSync(fixture, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  // --- Doc pin -----------------------------------------------------------------
  // guard(#265): dispatchDenial's own reason wording drifting from
  // docs/COORDINATION.md's stand-down copy — both describe the same fact
  // ("the app dispatches for this checkout instead") and must say so the
  // same way, or an operator reading one would not recognize the other.
  // pin: `claim-rules.mjs`'s `dispatchDenial` reason phrase ↔ `docs/COORDINATION.md`'s dispatch-scope description
  {
    const claimRulesText = readFileSync(join(root, 'plugins/port/hooks/lib/claim-rules.mjs'), 'utf8');
    const phrase = 'the app dispatches for this checkout';
    if (!claimRulesText.includes(phrase)) {
      fail('dispatch-claim-doc-pin', `claim-rules.mjs's dispatchDenial no longer states the phrase '${phrase}'`);
    } else {
      ok();
    }
    const coordinationText = readFileSync(join(root, 'docs/COORDINATION.md'), 'utf8');
    if (!coordinationText.includes(phrase)) {
      fail('dispatch-claim-doc-pin', `docs/COORDINATION.md no longer states the phrase '${phrase}'`);
    } else {
      ok();
    }
    const docsText = pipelineDocsText();
    if (!docsText.includes(phrase)) {
      fail('dispatch-claim-doc-pin', `PIPELINE.md no longer states the phrase '${phrase}'`);
    } else {
      ok();
    }
  }

  note('dispatch-claim: dispatchDenial unit cases, decide()\'s Agent arm, end-to-end wiring, hooks.json matcher, and the stand-down-copy doc pin');
}
