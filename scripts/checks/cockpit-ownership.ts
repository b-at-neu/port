import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, pipelineSkillText } from '../lib/files.ts';
import { resolveMatchers, subagentPayload, plainPayload, operatorWorktreePayload, makeCheck, makeDecide } from '../lib/guard-fixtures.ts';
import type { Reporter } from '../lib/report.ts';

export default async function ({ fail, ok, expect, note }: Reporter) {
  const { classifyOwnership: hookClassify, dispatchDenial, cockpitWriteDenial } = await import(
    pathToFileURL(join(root, 'plugins/port/hooks/lib/ownership-rules.mjs')).href
  );
  const { decide } = await import(pathToFileURL(join(root, 'plugins/port/hooks/lib/guard-rules.mjs')).href);

  const matchers = resolveMatchers(fail);
  const check = makeCheck(fail, ok);

  // --- Classifier parity lives in ownership.test.ts, where vitest resolves the app's TS import
  // naturally — this pins that the test exists and exercises both classifiers. ---
  {
    const testFile = 'apps/desktop/src/main/dispatch/ownership.test.ts';
    const text = readFileSync(join(root, testFile), 'utf8');
    if (!text.includes('ownership-rules.mjs')) {
      fail('cockpit-ownership-parity', `${testFile} does not import plugins/port/hooks/lib/ownership-rules.mjs — the hook/app parity test is missing`);
    } else if (!/hookClassify\(.*\)\)\.toEqual\(classifyOwnership\(/.test(text)) {
      fail('cockpit-ownership-parity', `${testFile} imports the hook's classifier but never asserts it against the app's own classifyOwnership on a shared fixture`);
    } else ok();
  }

  // --- The hook's own classifier, exercised directly here — the half this check CAN run
  // natively, confirmed against every verdict the shared contract names. ---
  {
    const fixtures: ReadonlyArray<{ readonly label: string; readonly exists: boolean; readonly text: string | null; readonly repo: string; readonly expectKind: string }> = [
      { label: 'no file at all', exists: false, text: null, repo: 'b-at-neu/port', expectKind: 'absent' },
      { label: 'repo mismatch reads as absent', exists: true, text: JSON.stringify({ repo: 'other/repo', owner: 'app', since: '2026-10-06T14:02:11Z' }), repo: 'b-at-neu/port', expectKind: 'absent' },
      { label: 'app owns it', exists: true, text: JSON.stringify({ repo: 'b-at-neu/port', owner: 'app', since: '2026-10-06T14:02:11Z' }), repo: 'b-at-neu/port', expectKind: 'app' },
      { label: 'terminal owns it', exists: true, text: JSON.stringify({ repo: 'b-at-neu/port', owner: 'terminal', since: '2026-10-06T14:02:11Z' }), repo: 'b-at-neu/port', expectKind: 'terminal' },
      { label: 'unparseable JSON', exists: true, text: 'not json', repo: 'b-at-neu/port', expectKind: 'unreadable' },
      { label: 'an array reads as a repo mismatch, not unreadable', exists: true, text: '[]', repo: 'b-at-neu/port', expectKind: 'absent' },
      { label: 'not an object', exists: true, text: '"just a string"', repo: 'b-at-neu/port', expectKind: 'unreadable' },
      { label: 'missing since', exists: true, text: JSON.stringify({ repo: 'b-at-neu/port', owner: 'app' }), repo: 'b-at-neu/port', expectKind: 'unreadable' },
      { label: 'unknown owner', exists: true, text: JSON.stringify({ repo: 'b-at-neu/port', owner: 'port-desktop', since: '2026-10-06T14:02:11Z' }), repo: 'b-at-neu/port', expectKind: 'unreadable' },
    ];
    for (const f of fixtures) {
      const verdict = hookClassify(f.exists, f.text, f.repo);
      expect(verdict.kind === f.expectKind, 'cockpit-ownership-parity', () => `${f.label}: expected the hook to classify '${f.expectKind}', got ${JSON.stringify(verdict)}`);
    }
  }

  // --- dispatchDenial — denies on app/unreadable, allows on absent/terminal. Subagent and
  // non-cockpit callers are exempt regardless of ownership. ---
  {
    const cockpitWho = { isSubagent: false, isOperatorWorktree: false, isManagedWorktree: false, agent: null, signal: null };
    const subagentWho = { isSubagent: true, isOperatorWorktree: false, isManagedWorktree: true, agent: 'impl-agent', signal: 'agent_type' };

    const app = { kind: 'app', since: '2026-10-06T14:02:11Z' };
    const terminal = { kind: 'terminal', since: '2026-10-06T14:02:11Z' };
    const absent = { kind: 'absent' };
    const unreadable = { kind: 'unreadable', message: "cockpit.json is missing 'since'" };

    const deniedApp = dispatchDenial({ toolName: 'Agent', who: cockpitWho, isCockpitSession: true, ownership: app });
    expect(deniedApp?.decision === 'deny', 'cockpit-ownership-dispatch', () => `expected ownership 'app' to deny a cockpit session's Agent call, got ${JSON.stringify(deniedApp)}`);

    const deniedUnreadable = dispatchDenial({ toolName: 'Agent', who: cockpitWho, isCockpitSession: true, ownership: unreadable });
    expect(deniedUnreadable?.decision === 'deny', 'cockpit-ownership-dispatch', () => `expected ownership 'unreadable' to deny exactly as 'app' does, got ${JSON.stringify(deniedUnreadable)}`);

    const allowedTerminal = dispatchDenial({ toolName: 'Agent', who: cockpitWho, isCockpitSession: true, ownership: terminal });
    expect(allowedTerminal === null, 'cockpit-ownership-dispatch', () => `expected ownership 'terminal' to never deny — this cockpit already owns the checkout, got ${JSON.stringify(allowedTerminal)}`);

    const allowedAbsent = dispatchDenial({ toolName: 'Agent', who: cockpitWho, isCockpitSession: true, ownership: absent });
    expect(allowedAbsent === null, 'cockpit-ownership-dispatch', () => `expected ownership 'absent' to never deny, got ${JSON.stringify(allowedAbsent)}`);

    const allowedSubagent = dispatchDenial({ toolName: 'Agent', who: subagentWho, isCockpitSession: true, ownership: app });
    expect(allowedSubagent === null, 'cockpit-ownership-dispatch', () => `expected a subagent to be exempt — stage agents already declare disallowedTools: Agent — got ${JSON.stringify(allowedSubagent)}`);

    const allowedNotCockpit = dispatchDenial({ toolName: 'Agent', who: cockpitWho, isCockpitSession: false, ownership: app });
    expect(allowedNotCockpit === null, 'cockpit-ownership-dispatch', () => `expected a non-cockpit session to never be denied, got ${JSON.stringify(allowedNotCockpit)}`);

    const allowedUnverifiable = dispatchDenial({ toolName: 'Agent', who: cockpitWho, isCockpitSession: null, ownership: app });
    expect(allowedUnverifiable === null, 'cockpit-ownership-dispatch', () => `expected an unreadable transcript (isCockpitSession: null) to fail open, got ${JSON.stringify(allowedUnverifiable)}`);
  }

  // --- decide()'s own Agent arm wires dispatchDenial correctly. ---
  {
    const gate = makeDecide(decide, { matchers, sessionRequiredPaths: [], root, isCockpitSession: true });
    check(
      'ownership app denies an Agent call from a cockpit-shaped session',
      gate({ payload: plainPayload({ tool_name: 'Agent', tool_input: { description: 'impl #52', subagent_type: 'port:impl-agent' } }), ownership: { kind: 'app', since: '2026-10-06T14:02:11Z' } }),
      'deny',
    );
    check(
      'the identical Agent call from a subagent is never denied by this rule',
      gate({ payload: subagentPayload({ tool_name: 'Agent', tool_input: { description: 'impl #52', subagent_type: 'port:impl-agent' } }), ownership: { kind: 'app', since: '2026-10-06T14:02:11Z' } }),
      'allow',
    );
    check(
      'ownership terminal never denies an Agent call',
      gate({ payload: plainPayload({ tool_name: 'Agent', tool_input: { description: 'impl #52', subagent_type: 'port:impl-agent' } }), ownership: { kind: 'terminal', since: '2026-10-06T14:02:11Z' } }),
      'allow',
    );
    check(
      'ownership absent never denies an Agent call',
      gate({ payload: plainPayload({ tool_name: 'Agent', tool_input: { description: 'impl #52', subagent_type: 'port:impl-agent' } }), ownership: { kind: 'absent' } }),
      'allow',
    );
  }

  // --- cockpitWriteDenial — denied for every caller, except a cockpit session's own takeover Write. ---
  {
    const cockpitWho = { isSubagent: false, isOperatorWorktree: false, isManagedWorktree: false, agent: null, signal: null };
    const subagentWho = { isSubagent: true, isOperatorWorktree: false, isManagedWorktree: true, agent: 'impl-agent', signal: 'agent_type' };
    const operatorWho = { isSubagent: false, isOperatorWorktree: true, isManagedWorktree: true, agent: null, signal: null };
    const path = join(root, '.agents', 'cockpit.json');
    const terminalContent = JSON.stringify({ repo: 'b-at-neu/port', owner: 'terminal', since: '2026-10-06T14:02:11Z' });
    const appContent = JSON.stringify({ repo: 'b-at-neu/port', owner: 'app', since: '2026-10-06T14:02:11Z' });

    const allowedTakeover = cockpitWriteDenial({
      toolName: 'Write',
      who: cockpitWho,
      filePath: path,
      cockpitFilePath: path,
      isCockpitSession: true,
      content: terminalContent,
      repo: 'b-at-neu/port',
      currentOwnership: { kind: 'absent' },
    });
    expect(allowedTakeover === null, 'cockpit-ownership-write', () => `expected a terminal cockpit's own preflight Write (absent → terminal) to be allowed, got ${JSON.stringify(allowedTakeover)}`);

    const allowedReentrant = cockpitWriteDenial({
      toolName: 'Write',
      who: cockpitWho,
      filePath: path,
      cockpitFilePath: path,
      isCockpitSession: true,
      content: terminalContent,
      repo: 'b-at-neu/port',
      currentOwnership: { kind: 'terminal', since: '2026-09-01T00:00:00Z' },
    });
    expect(allowedReentrant === null, 'cockpit-ownership-write', () => `expected a re-entrant terminal rewrite (terminal → terminal) to be allowed, got ${JSON.stringify(allowedReentrant)}`);

    const deniedOverApp = cockpitWriteDenial({
      toolName: 'Write',
      who: cockpitWho,
      filePath: path,
      cockpitFilePath: path,
      isCockpitSession: true,
      content: terminalContent,
      repo: 'b-at-neu/port',
      currentOwnership: { kind: 'app', since: '2026-10-06T14:02:11Z' },
    });
    expect(deniedOverApp?.decision === 'deny', 'cockpit-ownership-write', () => `expected a terminal takeover attempt over an 'app' record to be denied — only Take over in the app may do that, got ${JSON.stringify(deniedOverApp)}`);

    const deniedAppContent = cockpitWriteDenial({
      toolName: 'Write',
      who: cockpitWho,
      filePath: path,
      cockpitFilePath: path,
      isCockpitSession: true,
      content: appContent,
      repo: 'b-at-neu/port',
      currentOwnership: { kind: 'absent' },
    });
    expect(deniedAppContent?.decision === 'deny', 'cockpit-ownership-write', () => `expected a cockpit session writing owner 'app' to be denied — only the app's own main process writes that, got ${JSON.stringify(deniedAppContent)}`);

    for (const [label, who] of [
      ['subagent', subagentWho],
      ['operator worktree', operatorWho],
    ] as const) {
      const denied = cockpitWriteDenial({ toolName: 'Write', who, filePath: path, cockpitFilePath: path, isCockpitSession: false, content: terminalContent, repo: 'b-at-neu/port', currentOwnership: { kind: 'absent' } });
      expect(denied?.decision === 'deny', 'cockpit-ownership-write', () => `expected a ${label}'s Write to the ownership file to be denied — no exemption outside a cockpit session's own preflight, got ${JSON.stringify(denied)}`);
    }

    for (const toolName of ['Edit', 'NotebookEdit'] as const) {
      const denied = cockpitWriteDenial({ toolName, who: cockpitWho, filePath: path, cockpitFilePath: path, isCockpitSession: true, content: terminalContent, repo: 'b-at-neu/port', currentOwnership: { kind: 'absent' } });
      expect(denied?.decision === 'deny', 'cockpit-ownership-write', () => `expected ${toolName} to never qualify for the takeover exception — it carries no full content to classify, got ${JSON.stringify(denied)}`);
    }

    const unaffected = cockpitWriteDenial({ toolName: 'Write', who: cockpitWho, filePath: join(root, '.agents', 'denials.log'), cockpitFilePath: path, isCockpitSession: true, content: '', repo: 'b-at-neu/port', currentOwnership: { kind: 'absent' } });
    expect(unaffected === null, 'cockpit-ownership-write', () => `a write to a different path must not match on path equality, got ${JSON.stringify(unaffected)}`);
  }

  // --- End-to-end wiring: the real agent-guard.mjs against a temp fixture, since the
  // classifier's own import cannot see the hook's own ownership read/resolve wiring. ---
  {
    const hookPath = join(root, 'plugins/port/hooks/agent-guard.mjs');
    const fixture = mkdtempSync(join(tmpdir(), 'port-guard-ownership-'));
    try {
      mkdirSync(join(fixture, '.claude'), { recursive: true });
      mkdirSync(join(fixture, '.agents'), { recursive: true });
      writeFileSync(join(fixture, '.claude', 'port.config.json'), JSON.stringify({ repo: 'example/widgets', sessionRequiredPaths: ['CLAUDE.md', '.claude/**'], labels: {} }));
      writeFileSync(join(fixture, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(gh *)'] } }));
      writeFileSync(join(fixture, '.agents', 'cockpit.json'), JSON.stringify({ repo: 'example/widgets', owner: 'app', since: '2026-10-06T14:02:11Z' }));

      const transcriptPath = join(fixture, 'cockpit-transcript.jsonl');
      writeFileSync(transcriptPath, `${JSON.stringify({ type: 'user', message: { content: '<command-name>/port:pipeline</command-name>' } })}\n`);

      const run = (payload: Record<string, unknown>) =>
        execFileSync(process.execPath, [hookPath], { cwd: fixture, input: JSON.stringify(payload), stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf8' });

      const stdout = run({ cwd: fixture, session_id: 'sess-ownership-1', tool_name: 'Agent', transcript_path: transcriptPath, tool_input: { description: 'impl #52', subagent_type: 'port:impl-agent' } });
      let parsed: any;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        fail('cockpit-ownership-wiring', `expected JSON deny output against an app-owned repo, got ${JSON.stringify(stdout)}`);
      }
      expect(parsed && parsed.hookSpecificOutput?.permissionDecision === 'deny', 'cockpit-ownership-wiring', () => `expected permissionDecision 'deny' against an app-owned repo from a cockpit session, got ${JSON.stringify(parsed)}`);

      const writeDenied = run({ cwd: fixture, session_id: 'sess-ownership-2', transcript_path: transcriptPath, tool_name: 'Write', tool_input: { file_path: join(fixture, '.agents', 'cockpit.json'), content: JSON.stringify({ repo: 'example/widgets', owner: 'terminal', since: '2026-10-06T15:00:00Z' }) } });
      let writeParsed: any;
      try {
        writeParsed = JSON.parse(writeDenied);
      } catch {
        fail('cockpit-ownership-wiring', `expected JSON deny output for a terminal takeover attempt over an app-owned record, got ${JSON.stringify(writeDenied)}`);
      }
      expect(
        writeParsed && writeParsed.hookSpecificOutput?.permissionDecision === 'deny',
        'cockpit-ownership-wiring',
        () => `expected permissionDecision 'deny' for a Write attempting to take over an app-owned record, got ${JSON.stringify(writeParsed)}`,
      );

      // A plain (non-cockpit) session's transcript never trips the dispatch arm.
      const plainTranscriptPath = join(fixture, 'plain-transcript.jsonl');
      writeFileSync(plainTranscriptPath, `${JSON.stringify({ type: 'user', message: { content: 'hello' } })}\n`);
      const allowed = run({ cwd: fixture, session_id: 'sess-ownership-3', tool_name: 'Agent', transcript_path: plainTranscriptPath, tool_input: { description: 'impl #52', subagent_type: 'port:impl-agent' } });
      expect(allowed.trim() === '', 'cockpit-ownership-wiring', () => `expected no deny for a non-cockpit session, got ${JSON.stringify(allowed)}`);
    } catch (e: any) {
      if (e.status !== undefined) fail('cockpit-ownership-wiring', `hook exited non-zero: ${e.message}`);
      else throw e;
    } finally {
      rmSync(fixture, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  // --- hooks.json names an Agent matcher — the dispatch rule is only reachable if the hook actually fires for the Agent tool. ---
  {
    const hooksJson = JSON.parse(readFileSync(join(root, 'plugins/port/hooks/hooks.json'), 'utf8'));
    const matcherNames = (hooksJson.hooks?.PreToolUse ?? []).map((entry: { matcher?: string }) => entry.matcher);
    expect(matcherNames.includes('Agent'), 'cockpit-ownership-wiring', () => `hooks.json's PreToolUse matchers (${JSON.stringify(matcherNames)}) do not include 'Agent'`);
  }

  // pin: the two decided skill refusal lines — "port-desktop runs" and "Taken" — survive somewhere.
  {
    const skillText = pipelineSkillText();
    expect(skillText.includes('port-desktop runs'), 'cockpit-ownership-skill-pin', `the pipeline skill is missing the "port-desktop runs" refusal line`);
    expect(skillText.includes('Taken'), 'cockpit-ownership-skill-pin', `the pipeline skill is missing the "Taken" takeover-report line`);
  }

  note('cockpit-ownership: classifier parity, both decide() arms, the write arm, end-to-end wiring, hooks.json matcher, and the skill copy pins');
}
