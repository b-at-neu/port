// Layer 1 guards for #216 — a false "not port-managed" refusal, a git
// diagnostic that answered the wrong question, an unenforced "hard refusal"
// prose rule a session talked itself past, and an identity line whose sha
// and comparison ref were never pinned to their real sources.
//
// This ticket's own guards get their own topic module rather than landing in
// scripts/checks/cockpit.mjs or scripts/checks/hooks.mjs: both are already at
// the file-size ratchet (scripts/checks/file-size.config.json), so neither
// can take a new check until #182 splits them.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, walk, relOf, frontmatter } from '../lib/files.mjs';

export default async function ({ fail, ok }) {
  const skillRel = 'plugins/port/skills/pipeline/SKILL.md';
  const skillPath = join(root, skillRel);
  const skillText = readFileSync(skillPath, 'utf8');

  // Prose lines only — a blockquote (operator-facing UX copy) or a fenced
  // block (literal shell commands) is exempt from every phrase scan below,
  // the same carve-out "Running-plugin staleness" already uses in cockpit.mjs.
  const proseOnly = (text) => {
    const lines = text.split('\n');
    const out = [];
    let inFence = false;
    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence || line.trim().startsWith('>')) continue;
      out.push(line);
    }
    return out.join('\n');
  };

  // --- Preflight anchoring (#216 defect 1) ------------------------------------
  // Regression guard: the cockpit's config Read resolved against the session's
  // transcript directory rather than the repository, because SKILL.md named a
  // bare relative path with no repo anchor at all.
  {
    if (!skillText.includes('git rev-parse --show-toplevel')) {
      fail('preflight-anchoring', `${skillRel} no longer resolves a repository root with 'git rev-parse --show-toplevel'`);
    } else {
      ok();
    }
    for (const rootedPath of [
      '<root>/.claude/port.config.json',
      '<root>/.claude/settings.json',
      '<root>/.claude-plugin/marketplace.json',
      '<root>/.github/workflows/approval-check.yml',
    ]) {
      if (!skillText.includes(rootedPath)) {
        fail('preflight-anchoring', `${skillRel} never reads '${rootedPath}' — a repository-root file must be read as <root>/... , never a bare relative path`);
      } else {
        ok();
      }
    }
  }

  // --- Config diagnostic asks the right question (#216 defect 2) -------------
  // Regression guard: 'git rev-list --all' + 'git branch --contains' finds the
  // newest commit touching the file, not where the file exists — a question a
  // rebase invalidates on its own.
  {
    if (!skillText.includes('git cat-file -e')) {
      fail('preflight-config-diagnostic', `${skillRel} no longer tests config existence with 'git cat-file -e'`);
    } else {
      ok();
    }
    if (skillText.includes('git branch -a --contains') || skillText.includes('git rev-list --all')) {
      fail('preflight-config-diagnostic', `${skillRel} still carries the stale 'last commit touching the file' diagnostic`);
    } else {
      ok();
    }
    const skillAllowedTools = frontmatter(skillPath)?.['allowed-tools'] ?? '';
    if (!skillAllowedTools.includes('Bash(git cat-file *)')) {
      fail('preflight-config-diagnostic', `${skillRel}'s frontmatter allowed-tools is missing 'Bash(git cat-file *)'`);
    } else {
      ok();
    }
  }

  // --- Refusal rail is a checkable precondition, not bare prose (#216 defect 3)
  // Regression guard: "hard refusal with no override" was itself overridden —
  // the cockpit checked out another branch to escape its own stated refusal.
  {
    if (skillText.includes('hard refusal with no override')) {
      fail('preflight-refusal-rail', `${skillRel} still states the unenforced "hard refusal with no override" prose`);
    } else {
      ok();
    }
    if (!skillText.includes('checked-out branch unchanged')) {
      fail('preflight-refusal-rail', `${skillRel} is missing the checkable "stop with the checked-out branch unchanged" precondition`);
    } else {
      ok();
    }
  }

  // --- Identity line's two inputs are pinned, not printed from a guess
  // (#216 defect 4) -------------------------------------------------------------
  {
    if (!skillText.includes('not a prefix of the resolved record\'s `gitCommitSha`')) {
      fail('preflight-identity', `${skillRel} never states the sha-prefix precondition for the identity line's commit`);
    } else {
      ok();
    }
    if (!skillText.includes('render `staleness not computable` instead of a number')) {
      fail('preflight-identity', `${skillRel} never states the ref precondition for the identity line's comparison target`);
    } else {
      ok();
    }
  }

  // --- Guard against the generality mistake this ticket's own fixes could
  // introduce: no repository-specific literal in the new prose above. -------
  {
    const start = skillText.indexOf('## Startup preflight');
    const end = skillText.indexOf('## UX states (startup preflight)');
    if (start === -1 || end === -1) {
      fail('preflight-generality', `${skillRel} is missing the Startup preflight section`);
    } else {
      const startupProse = proseOnly(skillText.slice(start, end));
      for (const literal of ['b-at-neu/port', '`dev`']) {
        if (startupProse.includes(literal)) {
          fail('preflight-generality', `${skillRel}'s Startup preflight section names the literal '${literal}' outside a UX-state example`);
        } else {
          ok();
        }
      }
    }
  }

  // --- Branch-rule classifier (#216 defect 3) ---------------------------------
  // Unit-tests switchesBranch and the decide() branch rule directly, proving
  // the rule can both fire and stay out of the way before trusting it.
  {
    const { decide, invokedCockpitSkill, allowMatchers } = await import(
      pathToFileURL(join(root, 'plugins/port/hooks/lib/guard-rules.mjs')).href
    );
    const { switchesBranch } = await import(pathToFileURL(join(root, 'plugins/port/hooks/lib/command-rules.mjs')).href);

    // A synthetic allowlist matching the cockpit's *own* real-world
    // `allowed-tools` profile (git rev-parse/branch/cat-file — never
    // checkout), not this repository's broad `Bash(git *)` — the point of
    // these cases is to prove the branch rule's own reason fires (or does
    // not) independent of any repository's ordinary allowlist breadth.
    const classifierFixture = mkdtempSync(join(tmpdir(), 'port-branch-classifier-'));
    const classifierSettings = join(classifierFixture, 'settings.json');
    writeFileSync(
      classifierSettings,
      JSON.stringify({ permissions: { allow: ['Bash(git rev-parse *)', 'Bash(git branch *)', 'Bash(git cat-file *)', 'Bash(gh *)'] } }),
    );
    const matchers = allowMatchers([classifierSettings]);

    const check = (label, result, expected) => {
      if (result.decision !== expected) {
        fail('branch-rule-classifier', `${label}: expected '${expected}', got '${result.decision}'`);
      } else {
        ok();
      }
    };

    const cockpitPayload = (overrides = {}) => ({
      cwd: '/home/operator/some-project',
      session_id: 'sess-cockpit',
      tool_name: 'Bash',
      ...overrides,
    });
    const decideArgs = (payload, isCockpitSession) => ({
      payload,
      matchers,
      sessionRequiredPaths: [],
      root,
      isCockpitSession,
    });

    // A cockpit session `git checkout <branch>` → denied.
    check(
      'cockpit session git checkout',
      decide(decideArgs(cockpitPayload({ tool_input: { command: 'git checkout 205-checks-allowlist-wildcard' } }), true)),
      'deny',
    );

    // Same, `git switch` → denied.
    check(
      'cockpit session git switch',
      decide(decideArgs(cockpitPayload({ tool_input: { command: 'git switch main' } }), true)),
      'deny',
    );

    // Same, via `git -C <path> checkout` → denied.
    check(
      'cockpit session git -C checkout',
      decide(decideArgs(cockpitPayload({ tool_input: { command: 'git -C /some/path checkout main' } }), true)),
      'deny',
    );

    // A read-only git command from the same cockpit session → allowed by the
    // branch rule (it still needs to clear the ordinary allowlist, which
    // `git rev-parse` does).
    check(
      'cockpit session git rev-parse allowed',
      decide(decideArgs(cockpitPayload({ tool_input: { command: 'git rev-parse --abbrev-ref HEAD' } }), true)),
      'allow',
    );

    // The same checkout command, non-cockpit session → not denied by the
    // branch rule. It still misses the ordinary allowlist as a bare `git
    // checkout`, so the outcome is 'miss', never 'deny' by this rule.
    check(
      'non-cockpit session git checkout',
      decide(decideArgs(cockpitPayload({ tool_input: { command: 'git checkout main' } }), false)),
      'miss',
    );

    // isCockpitSession: null (transcript unreadable) → unverifiable, allows —
    // matching the gate rule's own null handling.
    check(
      'unreadable transcript git checkout',
      decide(decideArgs(cockpitPayload({ tool_input: { command: 'git checkout main' } }), null)),
      'miss',
    );

    // A subagent payload is never in scope for the branch rule — it is
    // already deny/allow purely on the ordinary subagent rules.
    check(
      'subagent git checkout not covered by the branch rule',
      decide(
        decideArgs(
          {
            cwd: '/home/operator/some-project/.claude/worktrees/agent-fixture',
            session_id: 'sess-agent',
            agent_type: 'impl-agent',
            agent_id: 'agent-1',
            tool_name: 'Bash',
            tool_input: { command: 'git checkout main' },
          },
          true,
        ),
      ),
      'deny', // deny — but from the ordinary allowlist-miss-for-subagent rule, not the branch rule
    );

    // An /port:implement impl-<n> operator worktree is exempt from the branch
    // rule, same as the loop and gate rules.
    check(
      'impl-<n> operator worktree git checkout is not denied by the branch rule',
      decide(
        decideArgs(
          {
            cwd: '/home/operator/some-project/.claude/worktrees/impl-503',
            session_id: 'sess-implement',
            tool_name: 'Bash',
            tool_input: { command: 'git checkout main' },
          },
          true,
        ),
      ),
      'miss',
    );

    // The words "checkout the branch" quoted inside an unrelated argument
    // must never trip the rule.
    check(
      'quoted checkout mention does not trip the rule',
      decide(decideArgs(cockpitPayload({ tool_input: { command: 'gh issue comment 5 -b "checkout the branch first"' } }), true)),
      'allow',
    );

    // switchesBranch itself, directly.
    if (!switchesBranch('git checkout main')) fail('branch-rule-classifier', 'switchesBranch: expected true for "git checkout main"');
    else ok();
    if (!switchesBranch('git switch -c tmp')) fail('branch-rule-classifier', 'switchesBranch: expected true for "git switch -c tmp"');
    else ok();
    if (!switchesBranch('git -C /repo checkout main')) fail('branch-rule-classifier', 'switchesBranch: expected true for "git -C /repo checkout main"');
    else ok();
    if (switchesBranch('git rev-parse --abbrev-ref HEAD')) fail('branch-rule-classifier', 'switchesBranch: expected false for a read-only git command');
    else ok();
    if (switchesBranch('gh pr checkout 5')) fail('branch-rule-classifier', 'switchesBranch: expected false — this is gh, not git');
    else ok();

    // A chained command carrying an earlier, unrelated `git` invocation
    // ahead of the checkout must still be caught — every command-position
    // `git` occurrence is scanned, not just the first.
    if (!switchesBranch('git branch --sort=-committerdate ; git checkout evil-branch')) {
      fail('branch-rule-classifier', 'switchesBranch: expected true for a chained command with an earlier git invocation (spaced separator)');
    } else ok();
    if (!switchesBranch('git branch --sort=-committerdate;git checkout evil-branch')) {
      fail('branch-rule-classifier', 'switchesBranch: expected true for a chained command with an earlier git invocation (unspaced separator)');
    } else ok();
    if (!switchesBranch('git status && git checkout evil-branch')) {
      fail('branch-rule-classifier', 'switchesBranch: expected true for a chained command joined with &&');
    } else ok();

    // A value-taking global flag like `-c` must not be mistaken for the git
    // subcommand itself — this repo's own shell-discipline block prescribes
    // exactly this idiom (`git -c core.editor=true rebase --continue`), so a
    // miss here would let a cockpit session slip a checkout past the rule
    // this ticket exists to add (#222, R3-M1).
    if (!switchesBranch('git -c core.editor=true checkout evil-branch')) {
      fail('branch-rule-classifier', 'switchesBranch: expected true for "git -c core.editor=true checkout evil-branch"');
    } else ok();
    if (switchesBranch('git -c core.editor=true rebase --continue')) {
      fail('branch-rule-classifier', 'switchesBranch: expected false for "git -c core.editor=true rebase --continue"');
    } else ok();

    // --- invokedCockpitSkill ---------------------------------------------------
    // The wrapper element is the whole tell — a bare mention of the skill
    // name in prose (SKILL.md's own pacing section names it) must not trip it.
    if (!invokedCockpitSkill('<command-name>/port:pipeline</command-name>')) {
      fail('branch-rule-classifier', 'invokedCockpitSkill: expected true for the real wrapper form');
    } else {
      ok();
    }
    if (!invokedCockpitSkill('<command-name>pipeline</command-name>')) {
      fail('branch-rule-classifier', 'invokedCockpitSkill: expected true with no namespace prefix');
    } else {
      ok();
    }
    if (invokedCockpitSkill('Run /port:pipeline to start the cockpit.')) {
      fail('branch-rule-classifier', 'invokedCockpitSkill: expected false for a bare prose mention with no wrapper element');
    } else {
      ok();
    }
    if (invokedCockpitSkill('')) fail('branch-rule-classifier', 'invokedCockpitSkill: expected false for empty text');
    else ok();

    rmSync(classifierFixture, { recursive: true, force: true, maxRetries: 3 });
  }

  // --- End-to-end wiring: the real hook script, a temp JSONL transcript -------
  // The classifier's own tests import guard-rules.mjs directly and cannot see
  // agent-guard.mjs's transcript read; this proves the wiring, not just the
  // decision logic.
  {
    const hookPath = join(root, 'plugins/port/hooks/agent-guard.mjs');
    const fixture = mkdtempSync(join(tmpdir(), 'port-guard-branch-hook-'));
    try {
      mkdirSync(join(fixture, '.claude'), { recursive: true });
      writeFileSync(join(fixture, '.claude', 'port.config.json'), '{"sessionRequiredPaths":["CLAUDE.md",".claude/**"]}');
      writeFileSync(join(fixture, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(git rev-parse *)'] } }));

      const transcriptFor = (text) => {
        const p = join(fixture, 'transcript.jsonl');
        writeFileSync(p, [JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text }] } }), ''].join('\n'));
        return p;
      };
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

      const cockpitTranscript = transcriptFor('<command-name>/port:pipeline</command-name>');
      let stdout = run({
        cwd: fixture,
        session_id: 'sess-branch-1',
        transcript_path: cockpitTranscript,
        tool_name: 'Bash',
        tool_input: { command: 'git checkout some-other-branch' },
      });
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        fail('branch-rule-hook-fixture', `expected JSON deny output for a cockpit-session checkout, got ${JSON.stringify(stdout)}`);
      }
      if (parsed && parsed.hookSpecificOutput?.permissionDecision !== 'deny') {
        fail('branch-rule-hook-fixture', `expected permissionDecision 'deny', got ${JSON.stringify(parsed)}`);
      }
      let lines = readLog();
      if (lines.length !== 1 || !lines[0].includes('\tdeny\t')) {
        fail('branch-rule-hook-fixture', `expected exactly one 'deny' line, got ${JSON.stringify(lines)}`);
      } else {
        ok();
      }

      const plainTranscript = transcriptFor('just an ordinary session transcript, no wrapper element anywhere');
      stdout = run({
        cwd: fixture,
        session_id: 'sess-branch-2',
        transcript_path: plainTranscript,
        tool_name: 'Bash',
        tool_input: { command: 'git checkout some-other-branch' },
      });
      if (stdout.trim() !== '') fail('branch-rule-hook-fixture', `expected no stdout for a non-cockpit session, got ${JSON.stringify(stdout)}`);
      lines = readLog();
      if (lines.length !== 2 || !lines[1].includes('\tmiss\t')) {
        fail('branch-rule-hook-fixture', `expected a 'miss' line (ordinary allowlist miss, not the branch rule), got ${JSON.stringify(lines)}`);
      } else {
        ok();
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  // --- The tell cannot be neutered by a shipped file naming it (#216) ---------
  // If any file under plugins/port/ carries the literal `<command-name>`
  // string, a session that merely reads that file would look like a cockpit.
  {
    const shipped = walk(join(root, 'plugins/port')).filter((f) => f.endsWith('.md') || f.endsWith('.mjs'));
    for (const f of shipped) {
      if (readFileSync(f, 'utf8').includes('<command-name>')) {
        fail('preflight-tell-guard', `${relOf(f)} carries the literal '<command-name>' string — this would make any session that reads it look like a cockpit`);
      } else {
        ok();
      }
    }
  }
}
