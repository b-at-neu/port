#!/usr/bin/env node
// Layer 1 of the testing loop: deterministic checks over the plugin's files.
//
// No model calls, no dependencies, and no plugin install required — a
// dispatched agent's worktree may not resolve the plugin, so every check here
// works from files alone.
//
// Each check exists because something actually broke. The failure mode these
// guard against is silence: a malformed component is *absent* from Claude
// Code's inventory rather than reported as an error, so nothing complains.
import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReporter } from './lib/report.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { fail, note, ok, report } = createReporter();

const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
const walk = (dir) =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((e) => {
        const p = join(dir, e);
        return statSync(p).isDirectory() ? walk(p) : [p];
      })
    : [];

/** Frontmatter key/value pairs. Deliberately not a YAML parser — presence and
 *  scalar shape is all these checks need, and a dependency is not worth it. */
function frontmatter(file) {
  const text = readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

// --- Components parse and declare what they must ---------------------------
// A skill or agent whose frontmatter is malformed is silently missing from the
// component inventory. Nothing errors; it simply is not there.
for (const [dir, kind] of [
  ['plugins/port/agents', 'agent'],
  ['plugins/port/skills', 'skill'],
]) {
  const files = walk(join(root, dir)).filter((f) =>
    kind === 'agent' ? f.endsWith('.md') : basename(f) === 'SKILL.md',
  );
  if (files.length === 0) fail('components', `no ${kind}s found under ${dir}`);
  for (const f of files) {
    const rel = f.slice(root.length + 1);
    const fm = frontmatter(f);
    if (!fm) {
      fail('frontmatter', `${rel} has no --- delimited frontmatter`);
      continue;
    }
    for (const key of ['name', 'description']) {
      if (!fm[key]) fail('frontmatter', `${rel} is missing '${key}'`);
    }
    const expected =
      kind === 'agent' ? basename(f, '.md') : basename(dirname(f));
    if (fm.name && fm.name !== expected) {
      fail('frontmatter', `${rel} declares name '${fm.name}', expected '${expected}'`);
    }
    ok();
  }
}

// --- Shell-discipline block stays byte-identical everywhere it fires -------
// Regression guard: the Bash hygiene rules drifted between agents because
// they were copied by hand. The canonical text lives once in PIPELINE.md
// between marker comments; every agent granting Bash must carry an exact
// copy, or the rules it actually has in context can silently fall behind the
// ones it was reviewed against.
{
  const BEGIN = '<!-- shell-discipline:begin -->';
  const END = '<!-- shell-discipline:end -->';
  const extractBlock = (text) => {
    const beginIdx = text.indexOf(BEGIN);
    const endIdx = text.indexOf(END);
    if (beginIdx === -1 || endIdx === -1) return null;
    return text.slice(beginIdx + BEGIN.length, endIdx).trim();
  };

  const pipelineRel = 'plugins/port/docs/PIPELINE.md';
  const canonical = extractBlock(readFileSync(join(root, pipelineRel), 'utf8'));
  if (canonical === null) {
    fail('shell-discipline', `canonical shell-discipline block missing from ${pipelineRel}`);
  } else {
    ok();
  }

  const agentFiles = walk(join(root, 'plugins/port/agents')).filter((f) => f.endsWith('.md'));
  let matched = 0;
  for (const f of agentFiles) {
    const rel = f.slice(root.length + 1);
    const fm = frontmatter(f) ?? {};
    const grantsBash =
      fm.tools === undefined || fm.tools.split(',').map((t) => t.trim()).includes('Bash');
    if (!grantsBash) continue;
    matched++;

    const block = extractBlock(readFileSync(f, 'utf8'));
    if (block === null) {
      fail('shell-discipline', `${rel} grants Bash but is missing the shell-discipline markers`);
    } else if (canonical === null) {
      note(`${rel}: skipped comparison — no canonical block to compare against`);
    } else if (block !== canonical) {
      fail('shell-discipline', `${rel}'s shell-discipline block has drifted from ${pipelineRel}'s canonical text`);
    } else {
      ok();
    }
  }
  if (matched < 4) {
    fail('shell-discipline', `only ${matched} agent(s) granting Bash matched under plugins/port/agents — expected at least 4`);
  } else {
    ok();
  }
}

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
  } = await import('file://' + join(root, 'plugins/port/hooks/lib/guard-rules.mjs'));

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
      rmSync(unmanaged, { recursive: true, force: true });
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
    rmSync(fixture, { recursive: true, force: true });
  }
}

// --- Templates are valid JSON ----------------------------------------------
for (const t of [
  'plugins/port/templates/permissions.base.json',
  'plugins/port/templates/labels.json',
  'plugins/port/templates/port.config.json',
  'schema/port.config.schema.json',
  '.claude-plugin/marketplace.json',
  'plugins/port/.claude-plugin/plugin.json',
]) {
  try {
    readJson(t);
    ok();
  } catch (e) {
    fail('json', `${t} does not parse: ${e.message}`);
  }
}

// --- Self-hosted marketplace entry stays pinned -----------------------------
// A bare `claude plugin marketplace add` rewrites this entry back to its
// unpinned form, which tracks the default branch instead of a release and
// silently reintroduces the drift #119 fixed.
//
// `ref` is legitimately either the release branch ('main') — this
// repository's own committed, contributor-facing pin — or a `v<semver>`
// release tag, which is what `/port:init` resolves for an adopting
// repository once a version has actually been published. Both forms are a
// deliberate pin; only the unpinned, ref-less shape `marketplace add` leaves
// behind is the drift this check guards against.
const MARKETPLACE_REF_PATTERN = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
{
  const settings = readJson('.claude/settings.json');
  const port = settings.extraKnownMarketplaces?.port;
  const ref = port?.source?.ref;
  if (ref !== 'main' && !MARKETPLACE_REF_PATTERN.test(ref ?? '')) {
    fail('marketplace', `extraKnownMarketplaces.port.source.ref must be 'main' or a 'v<semver>' tag, got ${JSON.stringify(ref)}`);
  }
  if (port?.autoUpdate !== true) {
    fail('marketplace', `extraKnownMarketplaces.port.autoUpdate must be true, got ${JSON.stringify(port?.autoUpdate)}`);
  }
  ok();
}

// --- README's documented install source stays pinned ------------------------
// The command adopters copy-paste. A docs edit that drops the `@main` pin
// looks like a harmless simplification but silently reinstates default-branch
// tracking -- the exact drift #146 fixed. `owner/repo@ref` and `owner/repo#ref`
// both parse; only a bare, ref-less source is disallowed here.
{
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  for (const line of readme.split('\n')) {
    const m = /claude plugin marketplace add\s+(\S+)/.exec(line);
    if (!m || !m[1].startsWith('b-at-neu/port')) continue;
    if (!/^b-at-neu\/port[@#]/.test(m[1])) {
      fail('marketplace', `README.md: marketplace add source must carry an @<ref> or #<ref> pin, got ${JSON.stringify(m[1])}`);
    }
  }
  ok();
}

// --- This repository's own permissions are non-empty -----------------------
// This is the exact condition the cockpit's startup preflight checks at
// runtime: a repository with `.claude/settings.json` present but
// `permissions.allow` missing or empty left the pilot repository with no
// permission rules at all, fully silently — stage agents run `dontAsk` and
// auto-deny anything not allowlisted.
{
  const settings = readJson('.claude/settings.json');
  const allow = settings.permissions?.allow;
  if (!Array.isArray(allow) || allow.length === 0) {
    fail('permissions', `.claude/settings.json's permissions.allow must be a non-empty array, got ${JSON.stringify(allow)}`);
  }
  ok();
}

// --- Label vocabulary matches the schema -----------------------------------
// Two files independently list the same label keys. They have drifted before.
{
  const templateKeys = new Set(readJson('plugins/port/templates/labels.json').labels.map((l) => l.key));
  const schemaKeys = new Set(
    Object.keys(readJson('schema/port.config.schema.json').properties.labels.properties),
  );
  for (const k of templateKeys) {
    if (!schemaKeys.has(k)) fail('labels', `'${k}' is in labels.json but not the schema`);
  }
  for (const k of schemaKeys) {
    if (!templateKeys.has(k)) fail('labels', `'${k}' is in the schema but not labels.json`);
  }
  ok();
}

// --- Artifact validator template is self-contained --------------------------
// An adopting repository copies plugins/port/templates/artifacts.mjs alone —
// no plugins/port/, no scripts/lib/ — so a relative import that resolves here
// and nowhere else would break silently for every adopter while passing in
// this repository.
{
  const rel = 'plugins/port/templates/artifacts.mjs';
  const text = readFileSync(join(root, rel), 'utf8');
  const relativeImport = /\bfrom\s+['"]\.\.?\//.exec(text);
  if (relativeImport) {
    fail('artifacts-template', `${rel} has a relative import (${JSON.stringify(relativeImport[0])}) — it must be self-contained`);
  } else {
    ok();
  }
}

// --- Artifact validator's LABELS table matches labels.json ------------------
// The template can't import labels.json (previous check), so it carries its
// own copy. The two must agree on keys, names, and modules, both directions,
// or `audit`'s label resolution silently drifts from the source of truth.
{
  const { LABELS } = await import('file://' + join(root, 'plugins/port/templates/artifacts.mjs'));
  const canonical = new Map(readJson('plugins/port/templates/labels.json').labels.map((l) => [l.key, l]));
  for (const [key, entry] of Object.entries(LABELS)) {
    const c = canonical.get(key);
    if (!c) {
      fail('artifacts-labels', `artifacts.mjs's LABELS has key '${key}', which is not in labels.json`);
    } else if (c.name !== entry.name || c.module !== entry.module) {
      fail(
        'artifacts-labels',
        `artifacts.mjs's LABELS.${key} is ${JSON.stringify(entry)}, but labels.json says ${JSON.stringify({ name: c.name, module: c.module })}`,
      );
    }
  }
  for (const key of canonical.keys()) {
    if (!(key in LABELS)) fail('artifacts-labels', `labels.json has key '${key}', missing from artifacts.mjs's LABELS`);
  }
  ok();
}

// --- Artifact validator's patterns accept a good example, reject a bad one --
// A check that cannot be made to fail is not a check. The commit case uses the
// real historical failure: a 378-character paragraph with no '#N ' prefix,
// standing in for the explanatory-text subject that recurred four times in one
// pipeline run before this validator existed.
{
  const { COMMIT_SUBJECT, REVIEW_HEADING, REVISION_HEADING, REVISION_OPENS, REVISION_DETAIL, OPERATOR_ONLY_STEP } =
    await import('file://' + join(root, 'plugins/port/templates/artifacts.mjs'));

  const cases = [
    [
      'COMMIT_SUBJECT',
      COMMIT_SUBJECT,
      '#149 fix the thing',
      'The first commit on this branch has a malformed subject line: instead of the required format, its subject is an entire paragraph of explanatory text describing everything that changed across every file touched by this pull request in exhaustive detail',
    ],
    ['REVIEW_HEADING', REVIEW_HEADING, '## Code Review — Cycle 1 · approved', '## Code Audit — Cycle 1 · approved'],
    ['REVISION_HEADING', REVISION_HEADING, '## Revision — Cycle 1', '## Revision (Cycle 1)'],
    ['OPERATOR_ONLY_STEP', OPERATOR_ONLY_STEP, '- [ ] **operator-only** click the button', '- [ ] click the button'],
  ];
  for (const [name, re, good, bad] of cases) {
    if (!re.test(good)) fail('artifacts-patterns', `${name} rejects its own good example ${JSON.stringify(good)}`);
    else if (re.test(bad)) fail('artifacts-patterns', `${name} accepts its bad example ${JSON.stringify(bad)}`);
    else ok();
  }

  const goodDetail = 'fixed R1-C1 · abc1234';
  const badDetail = 'Fixed the critical issue in the commit abc1234';
  if (!(REVISION_OPENS.test(goodDetail) && REVISION_DETAIL.test(goodDetail))) {
    fail('artifacts-patterns', `REVISION_DETAIL rejects its own good example ${JSON.stringify(goodDetail)}`);
  } else if (REVISION_OPENS.test(badDetail) && REVISION_DETAIL.test(badDetail)) {
    fail('artifacts-patterns', `REVISION_DETAIL accepts its bad example ${JSON.stringify(badDetail)}`);
  } else {
    ok();
  }
}

// --- Worktree reclamation template is self-contained and cross-platform ----
// Mirrors the artifacts-template rule: an adopting repository copies
// worktrees.mjs alone, and the script must never shell out via a POSIX-only
// binary name or a shell string, or it breaks silently on Windows (#144).
{
  const rel = 'plugins/port/templates/worktrees.mjs';
  const text = readFileSync(join(root, rel), 'utf8');

  const relativeImport = /\bfrom\s+['"]\.\.?\//.exec(text);
  if (relativeImport) {
    fail('worktrees-template', `${rel} has a relative import (${JSON.stringify(relativeImport[0])}) — it must be self-contained`);
  } else {
    ok();
  }

  if (/\bexecSync\b/.test(text)) {
    fail('worktrees-template', `${rel} uses execSync — every child process must use spawnSync with an explicit argv array`);
  } else {
    ok();
  }

  if (/shell:\s*true/.test(text)) {
    fail('worktrees-template', `${rel} passes shell: true to a child process — every call must be an explicit argv array, never a shell string`);
  } else {
    ok();
  }

  // Strip comment-only lines first — the file's own docstring names both
  // forbidden calls as a disclaimer ("Never in this script: `git fetch`,
  // `git worktree add`, …"), which must not itself trip this check.
  const codeOnly = text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
  if (/git\(\[['"]fetch['"]|git\(\[[^\]]*['"]worktree['"],\s*['"]add['"]/.test(codeOnly)) {
    fail('worktrees-template', `${rel} must never run 'git fetch' or 'git worktree add' — those are outside its contract`);
  } else {
    ok();
  }
}

// --- Worktree reclamation classifier ----------------------------------------
// Unit-tests the pure functions in isolation from every git/gh call — each
// case is a rung of the correlation ladder, a precedence rule from the
// classification table, or an acceptance criterion the ticket named.
{
  const { parsePorcelain, correlate, classifyCandidate } =
    await import('file://' + join(root, 'plugins/port/templates/worktrees.mjs'));

  // parsePorcelain: main worktree first, a linked one, a locked one with a
  // reason, and a detached one.
  {
    const porcelain = [
      'worktree /repo',
      'HEAD aaaa111',
      'branch refs/heads/dev',
      '',
      'worktree /repo/.claude/worktrees/impl-144',
      'HEAD bbbb222',
      'branch refs/heads/144-worktree-reclaim-install-guard',
      '',
      'worktree /repo/.claude/worktrees/agent-abc',
      'HEAD cccc333',
      'detached',
      'locked reason: agent still running',
      '',
    ].join('\n');
    const records = parsePorcelain(porcelain);
    if (records.length !== 3) {
      fail('worktrees-classifier', `parsePorcelain: expected 3 records, got ${records.length}`);
    } else if (records[0].path !== '/repo' || records[1].branch !== '144-worktree-reclaim-install-guard') {
      fail('worktrees-classifier', `parsePorcelain: unexpected record shape ${JSON.stringify(records)}`);
    } else if (!records[2].locked || records[2].lockReason !== 'reason: agent still running' || !records[2].detached) {
      fail('worktrees-classifier', `parsePorcelain: locked/detached record parsed wrong: ${JSON.stringify(records[2])}`);
    } else {
      ok();
    }
  }

  // correlate: each rung in turn, first hit wins, and #0 is never a
  // correlation.
  {
    const cases = [
      [{ upstreamMergeRef: 'refs/heads/503-fix-thing' }, { number: 503, rung: 'upstream-branch' }],
      [{ branch: '149-foo' }, { number: 149, rung: 'branch-name' }],
      [{ dirBasename: 'impl-77' }, { number: 77, rung: 'directory-basename' }],
      [{ headSubject: '#67 fix the thing' }, { number: 67, rung: 'head-subject' }],
      [{ headSubject: '#0 something' }, null],
      [{ headSubject: 'Merge pull request #157 from x' }, null],
      [{}, null],
      // First hit wins: upstream beats a branch name that would also match.
      [{ upstreamMergeRef: 'refs/heads/12-a', branch: '99-b' }, { number: 12, rung: 'upstream-branch' }],
    ];
    for (const [input, expected] of cases) {
      const got = correlate(input);
      const gotStr = JSON.stringify(got);
      const expStr = JSON.stringify(expected);
      if (gotStr !== expStr) {
        fail('worktrees-classifier', `correlate(${JSON.stringify(input)}): expected ${expStr}, got ${gotStr}`);
      } else {
        ok();
      }
    }
  }

  // classifyCandidate: precedence outside → protect → locked → dirty →
  // active → done/no-work → unresolved.
  {
    const cases = [
      ['outside beats everything', { isOutside: true, isProtected: true, locked: true, dirty: true, itemState: 'OPEN' }, 'outside', false],
      ['protect forces active over a done state', { isProtected: true, itemState: 'MERGED' }, 'active', false],
      ['locked beats a done state — reclaimable once unlocked', { locked: true, itemState: 'CLOSED' }, 'locked', false],
      ['dirty downgrades an otherwise-removable no-work candidate', { dirty: true, itemState: null, isAncestor: true }, 'dirty', false],
      ['dirty is irrelevant to an active candidate', { dirty: true, itemState: 'OPEN' }, 'active', false],
      ['OPEN is active, never removable', { itemState: 'OPEN' }, 'active', false],
      ['CLOSED is done, removable', { itemState: 'CLOSED' }, 'done', true],
      ['MERGED is done, removable', { itemState: 'MERGED' }, 'done', true],
      ['no correlation, HEAD is an ancestor of integration → no-work, removable', { itemState: null, isAncestor: true }, 'no-work', true],
      ['no correlation, HEAD is not an ancestor → unresolved, never removable', { itemState: null, isAncestor: false }, 'unresolved', false],
      ['NOT_FOUND (itemState null with no ancestor fact) → unresolved, never done', { itemState: null, isAncestor: null }, 'unresolved', false],
    ];
    for (const [label, input, expectedState, expectedRemovable] of cases) {
      const full = { isOutside: false, isProtected: false, locked: false, dirty: false, itemState: null, isAncestor: null, ...input };
      const got = classifyCandidate(full);
      if (got.state !== expectedState || got.removable !== expectedRemovable) {
        fail(
          'worktrees-classifier',
          `classifyCandidate — ${label}: expected {state: '${expectedState}', removable: ${expectedRemovable}}, got ${JSON.stringify(got)}`,
        );
      } else {
        ok();
      }
    }
  }
}

// --- Cockpit hygiene invokes the worktree script, never bare git worktree --
// Regression guard against #144's own fix collapsing back into the prose
// #62 already tried once: the cockpit's hygiene section must call
// `commands.worktrees` and must not itself run `git worktree remove`.
{
  const rel = 'plugins/port/skills/pipeline/SKILL.md';
  const text = readFileSync(join(root, rel), 'utf8');

  if (!text.includes('commands.worktrees')) {
    fail('worktree-hygiene', `${rel} never names 'commands.worktrees' — hygiene must be delegated to the script, not reimplemented in prose`);
  } else {
    ok();
  }

  const hygieneStart = text.indexOf('Worktree hygiene');
  if (hygieneStart === -1) {
    fail('worktree-hygiene', `${rel} has no 'Worktree hygiene' section`);
  } else {
    const hygieneEnd = text.indexOf('\n**Denial report', hygieneStart);
    const hygieneSection = hygieneEnd === -1 ? text.slice(hygieneStart) : text.slice(hygieneStart, hygieneEnd);
    if (/git worktree remove --force/.test(hygieneSection)) {
      fail('worktree-hygiene', `${rel}'s hygiene section still invokes 'git worktree remove --force' directly — this must be the script's job now`);
    } else {
      ok();
    }
  }
}

// --- Cockpit's config table carries commands.worktrees ----------------------
// The schema, the template, and self-hosting all name the same key — a
// mismatch here means the cockpit reads a placeholder nothing ever sets.
{
  const schemaProps = readJson('schema/port.config.schema.json').properties.commands.properties;
  if (!schemaProps.worktrees) {
    fail('worktree-hygiene', "schema/port.config.schema.json's commands object has no 'worktrees' property");
  } else {
    ok();
  }

  const template = readJson('plugins/port/templates/port.config.json');
  if (!('worktrees' in (template.commands ?? {}))) {
    fail('worktree-hygiene', 'plugins/port/templates/port.config.json has no commands.worktrees key');
  } else {
    ok();
  }

  const selfHost = readJson('.claude/port.config.json');
  if (typeof selfHost.commands?.worktrees !== 'string') {
    fail('worktree-hygiene', ".claude/port.config.json's commands.worktrees must be set for this repository's own self-hosting");
  } else {
    ok();
  }
}

// --- Cockpit's inline label-vocabulary table matches labels.json ------------
// Regression guard for #61: the cockpit resolves `labels[key] ?? default` from
// an inline copy of the vocabulary rather than reading labels.json directly,
// so the two tables must name the same keys and the same default name per key
// or the resolution the cockpit performs at startup silently drifts from the
// source of truth.
{
  const skillRel = 'plugins/port/skills/pipeline/SKILL.md';
  const skillText = readFileSync(join(root, skillRel), 'utf8');
  const tableMatch =
    /\| Config key \| Default name \| Role \| Module \|\n[ \t]*\|[-\s|]+\|\n((?:[ \t]*\|.*\|\n?)+)/.exec(
      skillText,
    );
  if (!tableMatch) {
    fail('label-vocabulary', `${skillRel} is missing the inline 'Config key | Default name' table`);
  } else {
    const inline = new Map();
    for (const line of tableMatch[1].split('\n')) {
      const row = /^[ \t]*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/.exec(line);
      if (row) inline.set(row[1], row[2]);
    }
    const canonical = new Map(
      readJson('plugins/port/templates/labels.json').labels.map((l) => [l.key, l.name]),
    );
    for (const [key, name] of inline) {
      if (!canonical.has(key)) {
        fail('label-vocabulary', `${skillRel} lists key '${key}', which is not in templates/labels.json`);
      } else if (canonical.get(key) !== name) {
        fail(
          'label-vocabulary',
          `${skillRel} names '${key}' as '${name}', but templates/labels.json says '${canonical.get(key)}'`,
        );
      }
    }
    for (const [key, name] of canonical) {
      if (!inline.has(key)) {
        fail('label-vocabulary', `templates/labels.json has key '${key}' ('${name}'), missing from ${skillRel}'s inline table`);
      }
    }
    ok();
  }
}

// --- No config key appears as a literal --label argument --------------------
// Regression guard for #61: `gh ... --label <unknown>` exits 0 with an empty
// result, so a config key (e.g. `planApproved`) typed directly into a
// `--label`/`--add-label`/`--remove-label` argument silently matches no real
// label instead of erroring. `<labels.planApproved>` is the placeholder and
// must not match; the bare string `planApproved` must. Extended for #148: the
// collapsed tick query expresses the same thing as a GraphQL `labels: [...]`
// list, which the original regex — keyed on `--label` flags only — would
// silently miss, letting the collapse reintroduce #61's exact failure mode
// one syntax over.
{
  const mismatched = readJson('plugins/port/templates/labels.json')
    .labels.filter((l) => l.key !== l.name)
    .map((l) => l.key);
  const files = walk(join(root, 'plugins')).filter((f) => f.endsWith('.md'));
  for (const f of files) {
    const rel = f.slice(root.length + 1);
    const text = readFileSync(f, 'utf8');
    const flagRe = /--(?:add-|remove-)?label\s+"([^"]*)"/g;
    let m;
    while ((m = flagRe.exec(text))) {
      const tokens = m[1].split(',').map((t) => t.trim());
      for (const token of tokens) {
        if (mismatched.includes(token)) {
          fail(
            'label-vocabulary',
            `${rel}: '${m[0]}' uses the config key '${token}' as a literal label name`,
          );
        }
      }
    }

    const graphqlRe = /labels:\s*\[([^\]]*)\]/g;
    while ((m = graphqlRe.exec(text))) {
      const tokens = [...m[1].matchAll(/"([^"]*)"/g)].map((t) => t[1]);
      for (const token of tokens) {
        if (mismatched.includes(token)) {
          fail(
            'label-vocabulary',
            `${rel}: GraphQL '${m[0]}' uses the config key '${token}' as a literal label name`,
          );
        }
      }
    }
  }
  ok();
}

// --- Label colours are well-formed and distinct -----------------------------
// Every label's position within its role ramp depends on a unique hex; a
// duplicate collapses two labels back to pixel-identical, silently.
{
  const labels = readJson('plugins/port/templates/labels.json').labels;
  const seen = new Map();
  for (const l of labels) {
    if (!/^[0-9A-F]{6}$/.test(l.color)) {
      fail('label-colors', `'${l.key}' has a malformed color '${l.color}', expected six uppercase hex digits`);
      continue;
    }
    if (seen.has(l.color)) {
      fail('label-colors', `'${l.key}' and '${seen.get(l.color)}' share color '${l.color}'`);
    } else {
      seen.set(l.color, l.key);
    }
  }
  ok();
}

// --- The config template matches its own schema's shape --------------------
// Regression test for checks written as bare strings: still valid JSON, still
// plausible-looking, and every consumer reading `entry.run` gets undefined.
{
  const cfg = readJson('plugins/port/templates/port.config.json');
  for (const entry of cfg.commands?.checks ?? []) {
    if (typeof entry !== 'object' || entry === null || typeof entry.run !== 'string') {
      fail('config-template', `commands.checks entries must be objects with a 'run' string, got ${JSON.stringify(entry)}`);
    }
  }
  for (const entry of cfg.commands?.bootstrap ?? []) {
    if (typeof entry !== 'string') {
      fail('config-template', `commands.bootstrap entries must be strings, got ${JSON.stringify(entry)}`);
    }
  }
  ok();
}

// --- Schema fixtures still discriminate ------------------------------------
// Needs a real validator. Reported as skipped rather than silently passing,
// because a check that quietly does nothing is worse than one that is absent.
{
  const fixtures = walk(join(root, 'schema/fixtures')).filter((f) => f.endsWith('.json'));
  const valid = fixtures.filter((f) => basename(f).startsWith('valid.'));
  const invalid = fixtures.filter((f) => basename(f).startsWith('invalid.'));
  if (valid.length === 0 || invalid.length === 0) {
    fail('fixtures', 'expected both valid.* and invalid.* fixtures');
  }
  for (const f of fixtures) {
    try {
      JSON.parse(readFileSync(f, 'utf8'));
    } catch (e) {
      fail('fixtures', `${basename(f)} does not parse: ${e.message}`);
    }
  }
  note(
    `fixtures: ${valid.length} valid, ${invalid.length} invalid — parse-checked only; run a draft 2020-12 validator for full coverage (see schema/README.md)`,
  );
  ok();
}

// --- Stale references -------------------------------------------------------
// Each of these named something real that was renamed or moved.
{
  const docs = [
    ...walk(join(root, 'plugins')),
    ...walk(join(root, 'docs')),
    ...walk(join(root, 'schema')),
    ...walk(join(root, 'evals')),
    join(root, 'README.md'),
    join(root, 'CONTRIBUTING.md'),
  ].filter((f) => f.endsWith('.md') && existsSync(f));

  const banned = [
    [/\bport-init\b/, 'the installer skill is `init`, invoked as /port:init'],
    [
      /`port\.config\.json`/,
      'the config lives at `.claude/port.config.json`',
      // /port:init's migration step names the legacy root location on purpose —
      // it is the one place that acts on it. Any other bare mention is stale.
      (line) => line.includes('repository root'),
    ],
    [/(^|[^:\w/])\/(pipeline|scope|implement|release|worktree-clean|analyze|init)\b/, 'skill references need the `port:` prefix'],
  ];
  for (const f of docs) {
    const rel = f.slice(root.length + 1);
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      for (const [re, why, exempt] of banned) {
        const m = re.exec(line);
        if (m && !(exempt && exempt(line))) {
          fail('stale-reference', `${rel}: ${why} (found ${JSON.stringify(m[0].trim())})`);
        }
      }
    }
  }
  ok();
}

// --- SESSION REQUIRED never rendered as a bare, uncoded marker line --------
// Regression guard for #156: the cockpit's consumer check used to be a bare
// substring search over the whole body, so any prompt file merely
// *discussing* the marker in prose false-positived. This is the producer-side
// mechanical half: every `SESSION REQUIRED` mention across the same doc set
// "Stale references" scans is either inside backticks or is the canonical
// `> **SESSION REQUIRED:** <reason>` rendering at line start — a reworded or
// unrendered marker fails here, in CI, rather than silently at dispatch time.
const SESSION_MARKER_LINE = /^>\s*\*\*SESSION REQUIRED:\*\*\s+\S/;
{
  const docs = [
    ...walk(join(root, 'plugins')),
    ...walk(join(root, 'docs')),
    ...walk(join(root, 'schema')),
    ...walk(join(root, 'evals')),
    join(root, 'README.md'),
    join(root, 'CONTRIBUTING.md'),
  ].filter((f) => f.endsWith('.md') && existsSync(f));

  for (const f of docs) {
    const rel = f.slice(root.length + 1);
    const text = readFileSync(f, 'utf8');
    // Skip YAML frontmatter — a skill's `description:` line may name the
    // marker bare (implement/SKILL.md's does), and no frontmatter value uses
    // backticks.
    const fm = /^---\n[\s\S]*?\n---\n?/.exec(text);
    const fileLines = text.split('\n');
    const startLine = fm ? fm[0].split('\n').length - 1 : 0;
    for (let i = startLine; i < fileLines.length; i++) {
      const line = fileLines[i];
      if (!line.includes('SESSION REQUIRED')) continue;
      if (SESSION_MARKER_LINE.test(line.trim())) continue;
      const outsideBackticks = line.replace(/`[^`]*`/g, '');
      if (outsideBackticks.includes('SESSION REQUIRED')) {
        fail(
          'session-required-rendering',
          `${rel}:${i + 1}: 'SESSION REQUIRED' appears outside inline code and is not the canonical '> **SESSION REQUIRED:** <reason>' rendering`,
        );
      }
    }
  }
  ok();
}

// A pure hyphenation or spacing mutation of the marker (e.g. `SESSION-REQUIRED`)
// drops the two-word substring the scan above keys on, so it slips through
// unnoticed there. This pins PIPELINE.md's own canonical example — the one
// directly under "One string, one rendering, both surfaces" — to the exact
// form, which is the copy every other file's example is meant to match.
{
  const rel = 'plugins/port/docs/PIPELINE.md';
  const fileLines = readFileSync(join(root, rel), 'utf8').split('\n');
  const anchor = 'One string, one rendering, both surfaces';
  const anchorIdx = fileLines.findIndex((l) => l.includes(anchor));
  if (anchorIdx === -1) {
    fail('session-required-rendering', `${rel} no longer declares the canonical marker anchor '${anchor}'`);
  } else {
    let exampleIdx = -1;
    for (let i = anchorIdx + 1; i < Math.min(anchorIdx + 8, fileLines.length); i++) {
      if (fileLines[i].trim().startsWith('>')) {
        exampleIdx = i;
        break;
      }
    }
    if (exampleIdx === -1) {
      fail('session-required-rendering', `${rel}:${anchorIdx + 1}: no blockquote example follows the canonical marker anchor`);
    } else if (!SESSION_MARKER_LINE.test(fileLines[exampleIdx].trim())) {
      fail(
        'session-required-rendering',
        `${rel}:${exampleIdx + 1}: canonical marker example is not '> **SESSION REQUIRED:** <reason>', got ${JSON.stringify(fileLines[exampleIdx].trim())}`,
      );
    } else {
      ok();
    }
  }
}

// --- Session-required determination reads the whole plan, not just changes -
// Regression guard for #118: the determination looked only at the changed-file
// list, so a plan whose testing steps needed a sessionRequiredPaths write (but
// whose deliverables did not) was declared plainly dispatchable, and the
// dispatched agent died on the permission prompt.
{
  const planAgent = readFileSync(join(root, 'plugins/port/agents/plan-agent.md'), 'utf8');
  const implAgent = readFileSync(join(root, 'plugins/port/agents/impl-agent.md'), 'utf8');

  const start = planAgent.indexOf('**Session-required declaration.**');
  if (start === -1) {
    fail('session-required-scan', 'plugins/port/agents/plan-agent.md has no "Session-required declaration" section');
  } else {
    const rest = planAgent.slice(start);
    // Scope tightly to the declaration's determination paragraph — stop at the
    // first blank line, not the next `## ` heading. The old bound ran all the
    // way to `## Handoff`, which also swallows the later "Human-runnable
    // manual steps ... in `## Testing`" bullet under "Use the fixed
    // structure", so a real deletion of the `## Testing` reference from the
    // determination sentence went undetected (R1-C1).
    const end = /\n\s*\n/.exec(rest);
    const section = end ? rest.slice(0, end.index) : rest;
    for (const heading of ['## Testing', '## Changes']) {
      if (!section.includes(heading)) {
        fail('session-required-scan', `plan-agent.md's Session-required declaration does not name '${heading}' as scanned`);
      }
    }
    ok();
  }

  for (const [rel, text] of [
    ['plugins/port/agents/plan-agent.md', planAgent],
    ['plugins/port/agents/impl-agent.md', implAgent],
  ]) {
    if (!text.includes('operator-only')) {
      fail('session-required-scan', `${rel} never mentions 'operator-only' — one file defines the prefix, the other must act on it`);
    } else {
      ok();
    }
  }
}

// --- Cockpit rails stay checkable preconditions, not bare prohibitions ------
// Regression guard for #120 / #138: both rails were plain "never do X"
// prose, and the cockpit did X anyway under a competing incentive. The fix
// re-shaped them into a batch recipe (shown inline at the multi-item
// commands) and a precondition (`unblock #N`) — this fails if a future edit
// quietly reverts either back to prose with nothing to check against.
{
  const skillRel = 'plugins/port/skills/pipeline/SKILL.md';
  const text = readFileSync(join(root, skillRel), 'utf8');

  if (!/\bunblock\b/i.test(text)) {
    fail('cockpit-rails', `${skillRel} never declares an 'unblock' command`);
  } else {
    ok();
  }

  const batchForm = [...text.matchAll(/gh issue edit(?:\s+\d+){2,}/g)];
  if (batchForm.length < 2) {
    fail('cockpit-rails', `${skillRel}: expected the batch form 'gh issue edit <n> <n> ...' to appear at least twice, found ${batchForm.length}`);
  } else {
    ok();
  }

  if (!text.includes('only when an operator instruction names that item')) {
    fail('cockpit-rails', `${skillRel} is missing the gate rail's precondition phrase 'only when an operator instruction names that item'`);
  } else {
    ok();
  }

  // Regression guard: the `<labels.approved>` never-touch rail is a
  // precondition too, not a bare prohibition — and the announcement that
  // claims a pull request is merge-ready has to show its work.
  if (!text.includes('only when a check on it has gone red')) {
    fail('cockpit-rails', `${skillRel} is missing the approved-carve-out precondition phrase 'only when a check on it has gone red'`);
  } else {
    ok();
  }

  if (!/every check and its conclusion/.test(text)) {
    fail('cockpit-rails', `${skillRel}'s approved-announcement copy never shows a check conclusion`);
  } else {
    ok();
  }
}

// --- Review evidence gate — verdicts wait for concluded checks --------------
// Regression guard: review-agent could form a verdict before the head
// commit's own artifact check had concluded — a check with no conclusion is
// pending, not passing, but was read as passing. This checks that the agent
// definition actually says to
// wait, names the timeout verdict, and conditions the one carve-out on the
// module that installs it, rather than a literal check name that would break
// the moment a repository renamed its workflow job.
{
  const rel = 'plugins/port/agents/review-agent.md';
  const text = readFileSync(join(root, rel), 'utf8');

  if (!text.includes('statusCheckRollup')) {
    fail('review-evidence', `${rel} never reads 'statusCheckRollup' — the evidence gate has nothing to reduce`);
  } else {
    ok();
  }

  if (!text.includes('--watch')) {
    fail('review-evidence', `${rel} never uses 'gh pr checks --watch' — nothing bounds the wait for pending checks`);
  } else {
    ok();
  }

  if (!text.includes('no verdict is formed while any check on the head commit is pending')) {
    fail('review-evidence', `${rel} is missing the literal phrase 'no verdict is formed while any check on the head commit is pending'`);
  } else {
    ok();
  }

  if (!/modules\.approvalGate/.test(text)) {
    fail('review-evidence', `${rel} never conditions the carve-out on 'modules.approvalGate'`);
  } else {
    ok();
  }

  if (!text.includes('blocked — checks pending')) {
    fail('review-evidence', `${rel} never names the 'blocked — checks pending' verdict`);
  } else {
    ok();
  }
}

// --- Generality guard — no literal CI check name in a stage prompt ----------
// Regression guard: hard-coding a check name (rather than deriving the one
// excused check from approval-check.yml's own jobs: key) breaks the moment a
// repository renames its workflow job or runs a different CI setup.
// `skills/init/SKILL.md` is deliberately exempt — it tells the operator which
// check to mark required, which is the one legitimate literal.
{
  const bannedNames = ['run-approval-check', 'run-static-checks', 'audit-artifacts', 'run-behavioural-evals'];
  const scanDirs = [join(root, 'plugins/port/agents'), join(root, 'plugins/port/skills/pipeline')];
  for (const dir of scanDirs) {
    for (const f of walk(dir).filter((p) => p.endsWith('.md'))) {
      const rel = f.slice(root.length + 1);
      const text = readFileSync(f, 'utf8');
      for (const name of bannedNames) {
        if (text.includes(name)) {
          fail('review-evidence', `${rel} names the literal check '${name}' — check identity must come from the repository's own workflow, never a hard-coded string`);
        }
      }
    }
  }
  ok();
}

// --- Rebase protocol resolves-and-escalates, not fail-closed-and-narrate ----
// Regression guard: a protocol that aborts the whole rebase on any single
// ambiguous hunk discards the correct resolution of every other one, and
// escalating by dumping conflict markers at a human who was never going to
// open an editor is unhelpful. This checks that the widened auto-resolvable
// rows and the decision-request escalation format are both still present.
{
  const rel = 'plugins/port/docs/PIPELINE.md';
  const text = readFileSync(join(root, rel), 'utf8');

  for (const phrase of ['take the union', 'deterministic order', 'apply the addition inside the new structure']) {
    if (!text.includes(phrase)) {
      fail('rebase-protocol', `${rel} is missing the auto-resolvable phrase '${phrase}'`);
    } else {
      ok();
    }
  }

  for (const name of ['sessionRequiredPaths', 'migration', 'environment', 'build configuration']) {
    if (!text.includes(name)) {
      fail('rebase-protocol', `${rel}'s never-auto-resolve list is missing '${name}'`);
    } else {
      ok();
    }
  }

  if (!text.includes('Recommendation')) {
    fail('rebase-protocol', `${rel}'s escalation format declares no 'Recommendation'`);
  } else {
    ok();
  }

  if (!/D<n>/.test(text)) {
    fail('rebase-protocol', `${rel}'s escalation format declares no 'D<n>' decision ID form`);
  } else {
    ok();
  }
}

// --- Eval cases are structurally sound --------------------------------------
// Everything statically knowable about a layer 3 case is checked here, for free,
// so a broken case is caught without an API key or early access. Presence and
// shape only, by regex — same reasoning as the frontmatter reader above.
{
  const caseFiles = walk(join(root, 'evals')).filter((f) => basename(f) === 'case.yaml');
  if (caseFiles.length === 0) {
    fail('evals', 'no evals/*/case.yaml found — layer 3 cases exist as files even before they can run');
  }

  const referenced = new Set();
  for (const f of caseFiles) {
    const rel = f.slice(root.length + 1);
    const text = readFileSync(f, 'utf8');
    for (const key of ['name', 'prompt', 'graders']) {
      if (!new RegExp(`^${key}:`, 'm').test(text)) {
        fail('evals', `${rel} is missing '${key}'`);
      }
    }
    // `graders:` is a block list — take the `- item` lines that follow it.
    const block = /^graders:[^\n]*\n((?:[ \t]+-[^\n]*\n?)*)/m.exec(text);
    const named = [...(block?.[1] ?? '').matchAll(/^[ \t]+-\s*(.+?)\s*$/gm)].map((m) => m[1]);
    if (block && named.length === 0) {
      fail('evals', `${rel} declares 'graders' but names none`);
    }
    for (const g of named) {
      referenced.add(g);
      if (!existsSync(join(root, 'evals/graders', g))) {
        fail('evals', `${rel} references grader '${g}', which is not a file under evals/graders/`);
      }
    }
    ok();
  }

  for (const g of walk(join(root, 'evals/graders')).filter((f) => f.endsWith('.md'))) {
    if (!referenced.has(basename(g))) {
      fail('evals', `evals/graders/${basename(g)} is referenced by no case`);
    }
  }
  ok();
}

// --- Behavioural evals never enter commands.checks --------------------------
// The mechanical form of the ticket's own last rule. `commands.checks` is what
// impl-agent runs before pushing, so an eval or an audit there means every
// dispatched agent spawning model runs, or shelling out to `gh` it cannot reach.
{
  const banned = [
    [/plugin\s+eval/, 'a behavioural eval'],
    [/artifacts\.mjs/, 'the artifact validator (audit shells out to `gh`; neither mode belongs in commands.checks)'],
  ];
  for (const rel of ['.claude/port.config.json', 'plugins/port/templates/port.config.json']) {
    if (!existsSync(join(root, rel))) continue;
    for (const entry of readJson(rel).commands?.checks ?? []) {
      for (const cmd of [entry?.run, entry?.fix]) {
        if (typeof cmd !== 'string') continue;
        for (const [re, what] of banned) {
          if (re.test(cmd)) {
            fail('checks-scope', `${rel} runs ${what} from commands.checks (${JSON.stringify(cmd)})`);
          }
        }
      }
    }
    ok();
  }
}

// --- Liveness reset — the cockpit resets only what it can prove it dispatched
// Regression guard for #150: every no-match used to be treated identically
// (report, never act), which left #66/#67 parked at `in progress` across a
// session boundary with no way to tell "this session's own dead dispatch"
// apart from "someone else's live agent" — recovery was a human noticing.
// This checks that the split, its proof artifact, and its one-reset cap are
// all still named, not quietly reverted to the old single-branch prose.
{
  const rel = 'plugins/port/skills/pipeline/SKILL.md';
  const text = readFileSync(join(root, rel), 'utf8');

  if (!text.includes('.temp/dispatch-log.md')) {
    fail('liveness-reset', `${rel} never names the '.temp/dispatch-log.md' artifact`);
  } else {
    ok();
  }

  if (!text.includes("reset only an item this session's own dispatch log records")) {
    fail(
      'liveness-reset',
      `${rel} is missing the literal precondition phrase "reset only an item this session's own dispatch log records"`,
    );
  } else {
    ok();
  }

  if (!text.includes('at most one automatic reset per item per session')) {
    fail(
      'liveness-reset',
      `${rel} is missing the literal phrase 'at most one automatic reset per item per session'`,
    );
  } else {
    ok();
  }

  if (!text.includes('GitHub reports it conflicting with its base')) {
    fail(
      'liveness-reset',
      `${rel}'s '<labels.approved>' carve-out never names the conflicting-with-base half`,
    );
  } else {
    ok();
  }
}

// --- Mergeability — no review dispatched against a diff CI never validated --
// Regression guard for #150: PR #134 was reviewed while `mergeable:
// CONFLICTING`, so the findings were against a diff CI had never actually run
// on — the conflict surfaced one stage later, in revise-agent. This checks
// that review-agent reads mergeable at both points named in the plan and
// states the no-verdict rule literally, and that both revise-agent and
// PIPELINE.md carry the '## Rebase required' contract the fix routes through.
{
  const reviewRel = 'plugins/port/agents/review-agent.md';
  const reviewText = readFileSync(join(root, reviewRel), 'utf8');

  for (const phrase of ['mergeable', 'CONFLICTING']) {
    if (!reviewText.includes(phrase)) {
      fail('mergeability', `${reviewRel} never reads '${phrase}'`);
    } else {
      ok();
    }
  }

  if (!reviewText.includes('no verdict is formed on a pull request that cannot be merged')) {
    fail(
      'mergeability',
      `${reviewRel} is missing the literal phrase 'no verdict is formed on a pull request that cannot be merged'`,
    );
  } else {
    ok();
  }

  const reviseRel = 'plugins/port/agents/revise-agent.md';
  const pipelineRel = 'plugins/port/docs/PIPELINE.md';
  for (const rel of [reviseRel, pipelineRel]) {
    const text = readFileSync(join(root, rel), 'utf8');
    if (!text.includes('## Rebase required')) {
      fail('mergeability', `${rel} never names the '## Rebase required' comment`);
    } else {
      ok();
    }
  }

  const pipelineText = readFileSync(join(root, pipelineRel), 'utf8');
  if (!pipelineText.includes('never on a schedule')) {
    fail('mergeability', `${pipelineRel} is missing the rebase-on-demand decision ('never on a schedule')`);
  } else {
    ok();
  }
}

// --- File contention — the cockpit holds overlapping dispatch, never races --
// Regression guard for #135: #67, #61 and #52 all claimed the same three
// files and were dispatched concurrently, so whichever pull request merged
// first invalidated the others' rebases. This checks that the fenced
// `files` contract exists in both PIPELINE.md and plan-agent.md, that
// PIPELINE.md records the decision never to express a hold as a new label
// or GitHub's dependency graph, and that SKILL.md's gate names its
// precondition, the `<labels.prOpened>` occupied-set input, and the
// `dispatch #N anyway` override.
{
  const pipelineRel = 'plugins/port/docs/PIPELINE.md';
  const planAgentRel = 'plugins/port/agents/plan-agent.md';
  const skillRel = 'plugins/port/skills/pipeline/SKILL.md';

  const pipelineText = readFileSync(join(root, pipelineRel), 'utf8');
  const planAgentText = readFileSync(join(root, planAgentRel), 'utf8');
  const skillText = readFileSync(join(root, skillRel), 'utf8');

  for (const [rel, text] of [
    [pipelineRel, pipelineText],
    [planAgentRel, planAgentText],
  ]) {
    if (!text.includes('```files')) {
      fail('file-contention', `${rel} never carries the '\`\`\`files' fence tag`);
    } else {
      ok();
    }
  }

  if (!pipelineText.includes("never a new label and never GitHub's dependency graph")) {
    fail(
      'file-contention',
      `${pipelineRel} is missing the literal phrase "never a new label and never GitHub's dependency graph"`,
    );
  } else {
    ok();
  }

  if (!skillText.includes('only when no in-flight item\'s plan claims the same file')) {
    fail(
      'file-contention',
      `${skillRel} is missing the literal precondition phrase "only when no in-flight item's plan claims the same file"`,
    );
  } else {
    ok();
  }

  if (!skillText.includes('<labels.prOpened>')) {
    fail('file-contention', `${skillRel} never names '<labels.prOpened>' as part of the occupied-set input`);
  } else {
    ok();
  }

  if (!skillText.includes('dispatch #N anyway')) {
    fail('file-contention', `${skillRel} never declares the 'dispatch #N anyway' override`);
  } else {
    ok();
  }
}

// --- Collapsed tick query — one round trip, never a per-label poll ---------
// Regression guard for #148: a tick used to cost ~15 `gh issue list`/`gh pr
// list --label` round trips. This checks that the Tick procedure actually
// names the collapsed single-call contract, and that no per-label polling
// call has crept back in under that heading — scoped to the Tick procedure
// section itself, so the Configuration section's illustrative mention of
// `gh issue list --label <unknown>` (explaining why a wrong string is silent,
// not the tick's own polling call) is correctly exempt.
{
  const rel = 'plugins/port/skills/pipeline/SKILL.md';
  const text = readFileSync(join(root, rel), 'utf8');

  for (const phrase of ['gh api graphql', '--include', '.temp/tick-state.md']) {
    if (!text.includes(phrase)) {
      fail('tick-query', `${rel} never names '${phrase}' — the collapsed tick contract is missing a piece`);
    } else {
      ok();
    }
  }

  const tickStart = text.indexOf('## Tick procedure');
  if (tickStart === -1) {
    fail('tick-query', `${rel} has no '## Tick procedure' heading`);
  } else {
    const tickEnd = text.indexOf('\n## ', tickStart + 1);
    const tickSection = tickEnd === -1 ? text.slice(tickStart) : text.slice(tickStart, tickEnd);
    const pollRe = /gh (?:issue|pr) list[^\n]*--label/g;
    const hits = [...tickSection.matchAll(pollRe)];
    if (hits.length > 0) {
      fail(
        'tick-query',
        `${rel}'s Tick procedure still issues a per-label poll (${JSON.stringify(hits[0][0])}) — the collapse must fold it into the one query`,
      );
    } else {
      ok();
    }
  }
}

// --- Pacing ladder — reset-on-change and never-stop are checkable, not prose
// Regression guard for #148: the old pacing rule measured as one speed in
// practice (26 of 27 wakeups at the floor over a real 25-hour run) because it
// conflated "an agent is running" with "something will move without a
// human". This checks the ladder's constants and its two load-bearing
// preconditions are still literal, checkable phrases.
{
  const rel = 'plugins/port/skills/pipeline/SKILL.md';
  const text = readFileSync(join(root, rel), 'utf8');

  for (const n of ['270', '540', '1080', '1800']) {
    if (!text.includes(n)) {
      fail('pacing-ladder', `${rel} is missing the ladder constant '${n}'`);
    } else {
      ok();
    }
  }

  if (!text.includes('Reset to the floor immediately on any observed change')) {
    fail(
      'pacing-ladder',
      `${rel} is missing the literal reset-on-change phrase 'Reset to the floor immediately on any observed change'`,
    );
  } else {
    ok();
  }

  if (!text.includes('Never stop — a stopped cockpit is the only dispatcher')) {
    fail(
      'pacing-ladder',
      `${rel} is missing the literal never-stop phrase 'Never stop — a stopped cockpit is the only dispatcher'`,
    );
  } else {
    ok();
  }
}

// --- No busy-waiting in the cockpit skill -----------------------------------
// Regression guard for #148: a real run issued 6 `sleep`-based waits inside
// tool calls, busy-waiting on CI instead of letting the next scheduled tick
// (or an event-driven completion) do the waiting.
{
  const rel = 'plugins/port/skills/pipeline/SKILL.md';
  const text = readFileSync(join(root, rel), 'utf8');
  if (/\bsleep\s+\d/.test(text)) {
    fail('no-busy-wait', `${rel} contains a 'sleep <n>'-shaped busy-wait — the next tick is how this cockpit waits`);
  } else {
    ok();
  }
}

// --- Ownership enforced client-side, and the blind-tick contract -----------
// Regression guard for #148: dropping the per-alias assignee filter (what
// makes the unowned sweep derivable from one call) must not silently drop
// the ownership rail itself, and a failed collapsed query must never be
// mistaken for an empty, all-clear tick.
{
  const rel = 'plugins/port/skills/pipeline/SKILL.md';
  const text = readFileSync(join(root, rel), 'utf8');

  if (!text.includes('never acted on, only reported')) {
    fail(
      'tick-query',
      `${rel} is missing the literal client-side ownership precondition phrase 'never acted on, only reported'`,
    );
  } else {
    ok();
  }

  if (!text.includes('dispatch nothing, run no hygiene, reset nothing')) {
    fail(
      'tick-query',
      `${rel} is missing the literal blind-tick precondition phrase 'dispatch nothing, run no hygiene, reset nothing'`,
    );
  } else {
    ok();
  }
}

// --- Unconditional cycle cap and the zero-diff review gate (#162) ----------
// Regression guard for #162: PR #157 ran 7 review cycles because the cap
// only fired "at reviewCycleCap and the latest review still produced
// Critical or Medium findings" — a condition every CI-only bounce (a
// liveness reset, an approval withdrawal, a manual re-label) arrives at
// with a clean latest review, so it never fired. This checks the cap
// dropped that qualifier, and that the zero-diff gate it gained alongside
// names the fields and comment it reads.
{
  const skillRel = 'plugins/port/skills/pipeline/SKILL.md';
  const pipelineRel = 'plugins/port/docs/PIPELINE.md';
  const skillText = readFileSync(join(root, skillRel), 'utf8');
  const pipelineText = readFileSync(join(root, pipelineRel), 'utf8');

  const capStart = skillText.indexOf('### Cycle cap');
  if (capStart === -1) {
    fail('cycle-cap', `${skillRel} has no '### Cycle cap' section`);
  } else {
    const capEnd = skillText.indexOf('\n## ', capStart);
    const capSection = capEnd === -1 ? skillText.slice(capStart) : skillText.slice(capStart, capEnd);

    if (capSection.includes('and the latest review still produced Critical or Medium findings')) {
      fail(
        'cycle-cap',
        `${skillRel}'s cycle cap still carries the 'and the latest review still produced Critical or Medium findings' qualifier — this is exactly what let #157 bounce through 7 clean cycles`,
      );
    } else {
      ok();
    }

    if (!capSection.includes('unconditional')) {
      fail('cycle-cap', `${skillRel}'s cycle cap section never states the cap is 'unconditional'`);
    } else {
      ok();
    }
  }

  const zeroDiffStart = skillText.indexOf('Zero-diff review gate');
  if (zeroDiffStart === -1) {
    fail('zero-diff-review', `${skillRel} never declares a 'Zero-diff review gate'`);
  } else {
    const zeroDiffEnd = skillText.indexOf('\n**File contention gate', zeroDiffStart);
    const zeroDiffSection = zeroDiffEnd === -1 ? skillText.slice(zeroDiffStart) : skillText.slice(zeroDiffStart, zeroDiffEnd);
    for (const phrase of ['commit.oid', 'headRefOid', '## Gate cleared']) {
      if (!zeroDiffSection.includes(phrase)) {
        fail('zero-diff-review', `${skillRel}'s zero-diff review gate never names '${phrase}'`);
      } else {
        ok();
      }
    }
  }

  if (!pipelineText.includes('unconditional')) {
    fail('cycle-cap', `${pipelineRel} never states the cycle cap is 'unconditional'`);
  } else {
    ok();
  }

  if (!pipelineText.includes('Zero-diff review')) {
    fail('zero-diff-review', `${pipelineRel} carries no 'Zero-diff review' rule`);
  } else {
    ok();
  }
}

// --- Report -----------------------------------------------------------------
report();
