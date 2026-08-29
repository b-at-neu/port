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
  } = await import('file://' + join(root, 'plugins/port/hooks/lib/guard-rules.mjs'));

  const settingsFile = join(root, '.claude/settings.json');
  const matchers = allowMatchers([settingsFile]);
  if (matchers === null) fail('guard-classifier', 'allowMatchers found no Bash allow entries in .claude/settings.json');

  const subagentPayload = (overrides = {}) => ({
    cwd: root,
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
{
  const settings = readJson('.claude/settings.json');
  const port = settings.extraKnownMarketplaces?.port;
  if (port?.source?.ref !== 'main') {
    fail('marketplace', `extraKnownMarketplaces.port.source.ref must be 'main', got ${JSON.stringify(port?.source?.ref)}`);
  }
  if (port?.autoUpdate !== true) {
    fail('marketplace', `extraKnownMarketplaces.port.autoUpdate must be true, got ${JSON.stringify(port?.autoUpdate)}`);
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
// must not match; the bare string `planApproved` must.
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
    [/scripts\/artifacts\.mjs/, 'the layer 2 artifact audit'],
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

// --- Report -----------------------------------------------------------------
report();
