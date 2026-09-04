import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson } from '../lib/files.mjs';

export default async function ({ fail, ok }) {
  // --- hooks.json command shape ----------------------------------------------
  // Regression test for the argv-array form, which loaded as Hooks (0): no
  // error, no warning, the hook simply absent.
  {
    const hooks = readJson('plugins/port/hooks/hooks.json');
    const entries = Object.values(hooks.hooks ?? {}).flat();
    if (entries.length === 0) fail('hooks', 'hooks.json declares no hooks');
    for (const matcher of entries) {
      for (const h of matcher.hooks ?? []) {
        if (typeof h.command !== 'string') {
          fail(
            'hooks',
            `command must be a shell string, got ${Array.isArray(h.command) ? 'an array' : typeof h.command}`,
          );
        }
        ok();
      }
    }
  }

  // --- Guard hook is wired on PreToolUse for Bash and the write tools --------
  // Regression guard for #67: the deny is a hook decision now, not a
  // prediction from `dontAsk`. A renamed hook file or a dropped matcher is
  // otherwise silently absent — nothing errors, the guard simply never fires.
  {
    const hooksJson = readJson('plugins/port/hooks/hooks.json');
    const entries = Object.entries(hooksJson.hooks ?? {});

    for (const [event, matchers] of entries) {
      for (const matcher of matchers) {
        for (const h of matcher.hooks ?? []) {
          const m = /\$\{CLAUDE_PLUGIN_ROOT\}\/(.+?)"/.exec(h.command ?? '');
          const rel = m?.[1];
          if (!rel || !existsSync(join(root, 'plugins/port', rel))) {
            fail('hook-wiring', `${event}/${matcher.matcher}: command references a missing file (${JSON.stringify(h.command)})`);
          } else {
            ok();
          }
        }
      }
    }

    const preToolUse = hooksJson.hooks?.PreToolUse ?? [];
    const coversBash = preToolUse.some((m) => m.matcher === 'Bash');
    const coversWrites = preToolUse.some((m) => /\bEdit\b/.test(m.matcher ?? '') && /\bWrite\b/.test(m.matcher ?? ''));
    if (!coversBash) fail('hook-wiring', 'PreToolUse declares no matcher covering Bash');
    if (!coversWrites) fail('hook-wiring', 'PreToolUse declares no matcher covering the write tools (Edit/Write/NotebookEdit)');
    ok();
  }

  // --- Guard hook classifier ---------------------------------------------------
  // Unit-tests the pure decision logic in isolation from stdin/stdout/exit-code
  // plumbing. Each case is the regression a real incident or the ticket's own
  // acceptance criteria named.
  {
    const {
      allowMatchers,
      decide,
      callerKind,
      globToRegExp,
      gateClearAttempt,
      recentOperatorMessages,
      operatorNamed,
      pluginInstallMutation,
    } = await import(pathToFileURL(join(root, 'plugins/port/hooks/lib/guard-rules.mjs')).href);

    const settingsFile = join(root, '.claude/settings.json');
    const matchers = allowMatchers([settingsFile]);
    if (matchers === null) fail('guard-classifier', 'allowMatchers found no Bash allow entries in .claude/settings.json');

    // A fixed, synthetic dispatched-agent worktree path — deliberately not
    // derived from `root`. `root` is wherever this script actually runs from,
    // which for a SESSION REQUIRED ticket is an `/port:implement` `impl-<n>`
    // worktree (this very ticket's own testing step runs from one) — reusing
    // it here would coincidentally satisfy `isOperatorWorktree` and silently
    // change what several cases below are actually testing, depending on
    // nothing but the directory the suite happens to run in.
    const subagentPayload = (overrides = {}) => ({
      cwd: '/home/operator/some-project/.claude/worktrees/agent-fixture123',
      session_id: 'sess-1',
      agent_type: 'impl-agent',
      agent_id: 'agent-1',
      tool_name: 'Bash',
      tool_input: { command: 'which claude' },
      ...overrides,
    });

    const check = (label, result, expected) => {
      if (result.decision !== expected) {
        fail('guard-classifier', `${label}: expected '${expected}', got '${result.decision}'`);
      } else {
        ok();
      }
    };

    // Subagent + non-allowlisted Bash → deny.
    check(
      'subagent non-allowlisted bash',
      decide({ payload: subagentPayload(), matchers, sessionRequiredPaths: [], root }),
      'deny',
    );

    // Same command, no agent signal → miss, never deny. A fabricated cwd, not
    // this checkout's own path — this script may itself be running inside a
    // dispatched agent's worktree, whose path legitimately matches the
    // worktree signal, which would otherwise make this case pass for the
    // wrong reason.
    check(
      'no-signal non-allowlisted bash',
      decide({
        payload: {
          cwd: '/home/operator/some-other-project',
          session_id: 'sess-2',
          tool_name: 'Bash',
          tool_input: { command: 'which claude' },
        },
        matchers,
        sessionRequiredPaths: [],
        root,
      }),
      'miss',
    );

    // Allowlisted command with an agent signal → allow.
    check(
      'subagent allowlisted bash',
      decide({
        payload: subagentPayload({ tool_input: { command: 'git status' } }),
        matchers,
        sessionRequiredPaths: [],
        root,
      }),
      'allow',
    );

    // Subagent write to a sessionRequiredPaths path → deny.
    check(
      'subagent write to session-required path',
      decide({
        payload: subagentPayload({
          tool_name: 'Write',
          tool_input: { file_path: join(root, '.claude/port.config.json') },
        }),
        matchers,
        sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
        root,
      }),
      'deny',
    );

    // Subagent write outside sessionRequiredPaths → allow.
    check(
      'subagent write outside session-required paths',
      decide({
        payload: subagentPayload({
          tool_name: 'Write',
          tool_input: { file_path: join(root, 'plugins/port/x.md') },
        }),
        matchers,
        sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
        root,
      }),
      'allow',
    );

    // The transcript and worktree signals each reach 'deny' on their own,
    // with no agent_type/agent_id present.
    check(
      'transcript signal alone',
      decide({
        payload: {
          cwd: root,
          session_id: 'sess-3',
          transcript_path: '/home/x/.claude/subagents/agent-abc123.jsonl',
          tool_name: 'Bash',
          tool_input: { command: 'which claude' },
        },
        matchers,
        sessionRequiredPaths: [],
        root,
      }),
      'deny',
    );
    check(
      'worktree signal alone',
      decide({
        payload: {
          cwd: join(root, '.claude/worktrees/agent-abc123'),
          session_id: 'sess-4',
          tool_name: 'Bash',
          tool_input: { command: 'which claude' },
        },
        matchers,
        sessionRequiredPaths: [],
        root,
      }),
      'deny',
    );

    // callerKind never string-matches a stage name — a namespaced agentType
    // still resolves via the agent_type signal.
    if (!callerKind({ agent_type: 'port:plan-agent' }).isSubagent) {
      fail('guard-classifier', 'callerKind missed a namespaced agent_type');
    }
    ok();

    // globToRegExp: '**' spans directories, '*' does not.
    if (!globToRegExp('.claude/**').test('.claude/settings.json')) {
      fail('guard-classifier', "globToRegExp('.claude/**') should match '.claude/settings.json'");
    }
    if (globToRegExp('.claude/*').test('.claude/a/b')) {
      fail('guard-classifier', "globToRegExp('.claude/*') should not cross a directory boundary");
    }
    ok();

    // --- Cockpit rules: loop rule (#120) ---------------------------------------
    const plainPayload = (overrides = {}) => ({
      cwd: '/home/operator/some-other-project',
      session_id: 'sess-plain',
      tool_name: 'Bash',
      ...overrides,
    });
    // A fabricated root-level path, not this checkout's own — this script may
    // itself be running inside a dispatched agent's worktree
    // (`.claude/worktrees/agent-<hash>`), whose ancestor path would otherwise
    // make `.claude/worktrees/impl-503` match the *agent* worktree signal too,
    // for the wrong reason. Same rationale as the 'no-signal' case above.
    const operatorWorktreePayload = (overrides = {}) => ({
      cwd: '/home/operator/some-other-project/.claude/worktrees/impl-503',
      session_id: 'sess-implement',
      tool_name: 'Bash',
      ...overrides,
    });

    // The #120 loop, from a plain (cockpit) session → denied.
    check(
      '#120 loop from a plain session',
      decide({
        payload: plainPayload({
          tool_input: {
            command:
              'for n in 63 67 71; do gh issue edit $n --repo b-at-neu/port --remove-label "planning" --add-label "ready"; done',
          },
        }),
        matchers,
        sessionRequiredPaths: [],
        root,
      }),
      'deny',
    );

    // The same command from an impl-<n> operator worktree → never denied by
    // the cockpit loop rule. It still misses the ordinary allowlist (a raw
    // shell `for` is not `gh ...`), so the outcome is 'miss', never 'deny' —
    // this asserts the *reason* changed, not that the command became
    // allowlisted.
    {
      const result = decide({
        payload: operatorWorktreePayload({
          tool_input: {
            command:
              'for n in 63 67 71; do gh issue edit $n --repo b-at-neu/port --remove-label "planning" --add-label "ready"; done',
          },
        }),
        matchers,
        sessionRequiredPaths: [],
        root,
      });
      if (result.decision === 'deny') {
        fail('guard-classifier', `#120 loop from an impl-<n> operator worktree: expected not 'deny' (cockpit rules are inert there), got 'deny'`);
      } else {
        ok();
      }
    }

    // The sanctioned batched form — no loop — from a plain session → allowed.
    check(
      'batched multi-item gh issue edit, no loop',
      decide({
        payload: plainPayload({
          tool_input: { command: 'gh issue edit 63 67 71 --repo b-at-neu/port --add-label "ready"' },
        }),
        matchers,
        sessionRequiredPaths: [],
        root,
      }),
      'allow',
    );

    // A loop over a command that is neither gh nor git → miss, never deny —
    // the loop rule only targets gh/git.
    check(
      'loop with no gh/git target',
      decide({
        payload: plainPayload({ tool_input: { command: 'for i in 1 2 3; do echo $i; done' } }),
        matchers,
        sessionRequiredPaths: [],
        root,
      }),
      'miss',
    );

    // Loop keywords quoted inside a `-b` argument must never trip the rule —
    // this is the quote-stripping regression.
    check(
      'loop keywords inside a quoted argument are not a loop',
      decide({
        payload: plainPayload({
          tool_input: { command: 'gh issue comment 5 -b "a loop for each item to do"' },
        }),
        matchers,
        sessionRequiredPaths: [],
        root,
      }),
      'allow',
    );

    // --- Cockpit rules: install rule (#144) -------------------------------------
    // Every install scope shares one `installPath`, so a plugin install run
    // from inside a managed worktree silently repoints every session on the
    // machine and keeps doing so after that worktree is gone. Unlike the loop
    // and gate rules, this one does **not** exempt `impl-<n>` — the blast
    // radius is identical whether an operator or a dispatched agent typed it.
    // Deliberately neither an `agent-` nor an `impl-` name — a worktree naming
    // scheme this repository's own harness doesn't happen to use, so this
    // isolates `isManagedWorktree` (any `.claude/worktrees/` path) from the two
    // *other* signals (`isSubagent` via the `agent-` pattern, `isOperatorWorktree`
    // via `impl-`) that would otherwise make these cases pass for a different
    // reason than the one being tested.
    const managedWorktreePayload = (overrides = {}) => ({
      cwd: '/home/operator/some-other-project/.claude/worktrees/other-9',
      session_id: 'sess-worktree',
      tool_name: 'Bash',
      ...overrides,
    });

    check(
      'install from a dispatched-agent worktree is denied',
      decide({
        payload: subagentPayload({ tool_input: { command: 'claude plugin install port@port --scope local' } }),
        matchers,
        sessionRequiredPaths: [],
        root,
      }),
      'deny',
    );

    check(
      'install from a plain session inside a managed worktree is denied',
      decide({
        payload: managedWorktreePayload({ tool_input: { command: 'claude plugin install port@port --scope local' } }),
        matchers,
        sessionRequiredPaths: [],
        root,
      }),
      'deny',
    );

    // The one cockpit-class rule that does NOT exempt impl-<n> — an install
    // performed from an /port:implement operator worktree repoints every
    // session on the machine exactly as one from a dispatched agent's
    // worktree would.
    check(
      'install from an impl-<n> operator worktree is still denied',
      decide({
        payload: operatorWorktreePayload({ tool_input: { command: 'claude plugin marketplace add /abs/path --scope local' } }),
        matchers,
        sessionRequiredPaths: [],
        root,
      }),
      'deny',
    );

    check(
      // 'claude' is not on this repository's Bash allowlist at all, so the
      // install rule not firing here surfaces as 'miss' (a normal permission
      // prompt), never 'deny' — the point is that the install rule itself
      // does not add a denial outside a managed worktree, not that the
      // command is allowlisted.
      'install from the main checkout is not denied by the install rule',
      decide({
        payload: plainPayload({ tool_input: { command: 'claude plugin install port@port --scope local' } }),
        matchers,
        sessionRequiredPaths: [],
        root,
      }),
      'miss',
    );

    check(
      'read-only plugin subcommand from a managed worktree is not denied by the install rule',
      decide({
        payload: managedWorktreePayload({ tool_input: { command: 'claude plugin list' } }),
        matchers,
        sessionRequiredPaths: [],
        root,
      }),
      'miss',
    );

    check(
      'the words "plugin install" quoted inside an unrelated argument do not trip the rule',
      decide({
        payload: managedWorktreePayload({
          tool_input: { command: 'gh issue comment 5 -b "please run claude plugin install port manually"' },
        }),
        matchers,
        sessionRequiredPaths: [],
        root,
      }),
      'allow',
    );

    // pluginInstallMutation itself, directly.
    {
      if (!pluginInstallMutation('claude plugin install port@port --scope local')) {
        fail('guard-classifier', 'pluginInstallMutation: expected true for "claude plugin install"');
      } else {
        ok();
      }
      if (!pluginInstallMutation('claude plugin marketplace add /abs/path --scope local')) {
        fail('guard-classifier', 'pluginInstallMutation: expected true for "claude plugin marketplace add"');
      } else {
        ok();
      }
      if (pluginInstallMutation('claude plugin details port')) {
        fail('guard-classifier', 'pluginInstallMutation: expected false for a read-only subcommand');
      } else {
        ok();
      }
    }

    // --- Cockpit rules: gate rule (#138) ----------------------------------------
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

    // Same command, with an operator message naming #134 → gate-clear (allowed
    // and logged as the audit record, never a plain 'allow').
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

  // --- Guard hook end-to-end wiring -------------------------------------------
  // Spawns the real hook script, so a stdin/stdout/exit-code mistake the
  // classifier's direct import cannot see still surfaces. The fixture directory
  // must sit outside any git repository, or `git rev-parse --git-common-dir`
  // resolves to this checkout and the fixture appends to the operator's own
  // `.agents/denials.log`.
  {
    const hookPath = join(root, 'plugins/port/hooks/agent-guard.mjs');
    const fixture = mkdtempSync(join(tmpdir(), 'port-guard-hook-'));
    try {
      mkdirSync(join(fixture, '.claude'), { recursive: true });
      writeFileSync(join(fixture, '.claude', 'port.config.json'), '{"sessionRequiredPaths":["CLAUDE.md",".claude/**"]}');
      writeFileSync(
        join(fixture, '.claude', 'settings.json'),
        JSON.stringify({ permissions: { allow: ['Bash(git *)'] } }),
      );

      const run = (payload) =>
        execFileSync(process.execPath, [hookPath], {
          cwd: fixture,
          input: JSON.stringify(payload),
          stdio: ['pipe', 'pipe', 'ignore'],
          encoding: 'utf8',
        });
      const readLog = () => {
        const p = join(fixture, '.agents', 'denials.log');
        return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean) : [];
      };

      // Subagent, non-allowlisted Bash → stdout carries the deny JSON, log gets a 'deny' line.
      let stdout = run({
        cwd: fixture,
        session_id: 'sess-1',
        agent_id: 'agent-1',
        agent_type: 'impl-agent',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      });
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        fail('guard-hook-fixture', `expected JSON deny output, got ${JSON.stringify(stdout)}`);
      }
      if (parsed && parsed.hookSpecificOutput?.permissionDecision !== 'deny') {
        fail('guard-hook-fixture', `expected permissionDecision 'deny', got ${JSON.stringify(parsed)}`);
      }
      let lines = readLog();
      if (lines.length !== 1) fail('guard-hook-fixture', `expected 1 log line after a subagent deny, got ${lines.length}`);
      else if (lines[0].split('\t').length !== 4) fail('guard-hook-fixture', `expected 4 tab-separated fields, got ${JSON.stringify(lines[0])}`);
      else if (!lines[0].includes('\tdeny\t')) fail('guard-hook-fixture', `expected a 'deny' line, got ${JSON.stringify(lines[0])}`);
      else if (!lines[0].includes('\tport:impl-agent\t')) fail('guard-hook-fixture', `expected actor 'port:impl-agent', got ${JSON.stringify(lines[0])}`);
      ok();

      // Non-subagent, non-allowlisted Bash → no stdout, log gets a 'miss' line.
      stdout = run({
        cwd: fixture,
        session_id: 'sess-2',
        tool_name: 'Bash',
        tool_input: { command: 'gh pr merge 1' },
      });
      if (stdout.trim() !== '') fail('guard-hook-fixture', `expected no stdout for a non-subagent miss, got ${JSON.stringify(stdout)}`);
      lines = readLog();
      if (lines.length !== 2) fail('guard-hook-fixture', `expected 2 lines after a non-subagent miss, got ${lines.length}`);
      else if (!lines[1].includes('\tmiss\t')) fail('guard-hook-fixture', `expected a 'miss' line, got ${JSON.stringify(lines[1])}`);
      ok();

      // Allowlisted Bash → no stdout, nothing logged (an 'allow' is never logged).
      run({ cwd: fixture, session_id: 'sess-3', tool_name: 'Bash', tool_input: { command: 'git status' } });
      if (readLog().length !== 2) fail('guard-hook-fixture', 'an allowed command should not append a line');
      ok();

      // No port.config.json in cwd → silent, nothing written.
      const unmanaged = mkdtempSync(join(tmpdir(), 'port-guard-hook-unmanaged-'));
      try {
        execFileSync(process.execPath, [hookPath], {
          cwd: unmanaged,
          input: JSON.stringify({ cwd: unmanaged, session_id: 'sess-4', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }),
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        if (existsSync(join(unmanaged, '.agents', 'denials.log'))) {
          fail('guard-hook-fixture', 'wrote a log file outside a port-managed repository');
        }
        ok();
      } finally {
        rmSync(unmanaged, { recursive: true, force: true, maxRetries: 3 });
      }

      // Malformed payload → fails open, logs 'hook-error'.
      execFileSync(process.execPath, [hookPath], {
        cwd: fixture,
        input: 'not json',
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      lines = readLog();
      if (lines.length !== 3) fail('guard-hook-fixture', `expected a hook-error line for a malformed payload, got ${lines.length} lines`);
      else if (!lines[2].includes('\thook-error\t')) fail('guard-hook-fixture', `expected a 'hook-error' line, got ${JSON.stringify(lines[2])}`);
      ok();
    } catch (e) {
      if (e.status !== undefined) fail('guard-hook-fixture', `hook exited non-zero: ${e.message}`);
      else throw e;
    } finally {
      rmSync(fixture, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}
