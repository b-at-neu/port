// Layer 1 guards against a false "not port-managed" refusal, a git diagnostic that answered
// the wrong question, an unenforced "hard refusal" talked past, and an identity line printed from a guess.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, walk, relOf, frontmatter, pipelineSkillText } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

export default async function ({ expect, fail, ok }: Reporter) {
  const skillRel = 'plugins/port/skills/pipeline/SKILL.md';
  const skillPath = join(root, skillRel);
  // The startup preflight and its UX states live in PREFLIGHT.md, so phrase scans below read the skill union rather than either file alone.
  const unionRel = 'plugins/port/skills/pipeline/*.md';
  const skillText = pipelineSkillText();
  const preflightRel = 'plugins/port/skills/pipeline/PREFLIGHT.md';
  const preflightText = readFileSync(join(root, preflightRel), 'utf8');

  // Prose lines only — a blockquote or fenced block is exempt from every phrase scan below.
  const proseOnly = (text: string): string => {
    const lines = text.split('\n');
    const out: string[] = [];
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

  // --- Preflight anchoring: the config Read must never resolve against the session's
  // transcript directory instead of the repository, reporting a false "not port-managed". ---
  {
    expect(skillText.includes('git rev-parse --show-toplevel'), 'preflight-anchoring', `${unionRel} no longer resolves a repository root with 'git rev-parse --show-toplevel'`);
    for (const rootedPath of [
      '<root>/.claude/port.config.json',
      '<root>/.claude/settings.json',
      '<root>/.claude-plugin/marketplace.json',
      '<root>/.github/workflows/approval-check.yml',
    ]) {
      expect(skillText.includes(rootedPath), 'preflight-anchoring', `${unionRel} never reads '${rootedPath}' — a repository-root file must be read as <root>/... , never a bare relative path`);
    }
  }

  // --- Config diagnostic asks the right question: must test where the file exists, never the
  // newest commit touching it — a question a rebase invalidates on its own. ---
  {
    expect(skillText.includes('git cat-file -e'), 'preflight-config-diagnostic', `${unionRel} no longer tests config existence with 'git cat-file -e'`);
    expect(!(skillText.includes('git branch -a --contains') || skillText.includes('git rev-list --all')), 'preflight-config-diagnostic', `${unionRel} still carries the stale 'last commit touching the file' diagnostic`);
    const skillAllowedTools = frontmatter(skillPath)?.['allowed-tools'] ?? '';
    expect(skillAllowedTools.includes('Bash(git cat-file *)'), 'preflight-config-diagnostic', `${skillRel}'s frontmatter allowed-tools is missing 'Bash(git cat-file *)'`);
  }

  // --- Refusal rail is a checkable precondition, not bare prose — an unenforced "hard
  // refusal" must never be escaped by the very session it was meant to stop. ---
  {
    expect(!skillText.includes('hard refusal with no override'), 'preflight-refusal-rail', `${unionRel} still states the unenforced "hard refusal with no override" prose`);
    expect(skillText.includes('checked-out branch unchanged'), 'preflight-refusal-rail', `${unionRel} is missing the checkable "stop with the checked-out branch unchanged" precondition`);
  }

  // --- Identity line's two inputs are pinned, not printed from a guess — a sha or
  // comparison ref must never come from the wrong source. ---
  {
    expect(skillText.includes('not a prefix of the resolved record\'s `gitCommitSha`'), 'preflight-identity', `${unionRel} never states the sha-prefix precondition for the identity line's commit`);
    expect(skillText.includes('render `staleness not computable` instead of a number'), 'preflight-identity', `${unionRel} never states the ref precondition for the identity line's comparison target`);
    // A self-hosting directory source below the repository root must never read as not computable.
    expect(skillText.includes('this working tree or a directory inside it'), 'preflight-identity', `${unionRel} no longer widens the self-hosting directory-source case to "this working tree or a directory inside it"`);
  }

  // --- No repository-specific literal in the new prose above — reads PREFLIGHT.md directly
  // (a structural heading slice), never the union, which could also match SKILL.md's own pointer heading. ---
  {
    const start = preflightText.indexOf('## Startup preflight');
    const end = preflightText.indexOf('## UX states (startup preflight)');
    if (start === -1 || end === -1) {
      fail('preflight-generality', `${preflightRel} is missing the Startup preflight section`);
    } else {
      const startupProse = proseOnly(preflightText.slice(start, end));
      for (const literal of ['b-at-neu/port', '`dev`']) {
        expect(!startupProse.includes(literal), 'preflight-generality', `${preflightRel}'s Startup preflight section names the literal '${literal}' outside a UX-state example`);
      }
    }
  }

  // --- Branch-rule classifier: unit-tests switchesBranch and decide() directly, proving the
  // rule can both fire and stay out of the way before trusting it. ---
  {
    const { decide, invokedCockpitSkill, allowMatchers } = await import(
      pathToFileURL(join(root, 'plugins/port/hooks/lib/guard-rules.mjs')).href
    );
    const { switchesBranch } = await import(pathToFileURL(join(root, 'plugins/port/hooks/lib/command-rules.mjs')).href);

    // A synthetic allowlist matching the cockpit's own real-world profile, not this repository's broad `Bash(git *)`, so these cases prove the branch rule's reason independent of allowlist breadth.
    const classifierFixture = mkdtempSync(join(tmpdir(), 'port-branch-classifier-'));
    const classifierSettings = join(classifierFixture, 'settings.json');
    writeFileSync(
      classifierSettings,
      JSON.stringify({ permissions: { allow: ['Bash(git rev-parse *)', 'Bash(git branch *)', 'Bash(git cat-file *)', 'Bash(gh *)'] } }),
    );
    const matchers = allowMatchers([classifierSettings]);

    const check = (label: string, result: any, expected: string) => {
      expect(!(result.decision !== expected), 'branch-rule-classifier', `${label}: expected '${expected}', got '${result.decision}'`);
    };

    const cockpitPayload = (overrides = {}) => ({
      cwd: '/home/operator/some-project',
      session_id: 'sess-cockpit',
      tool_name: 'Bash',
      ...overrides,
    });
    const decideArgs = (payload: any, isCockpitSession: boolean | null) => ({
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

    // A read-only git command from the same cockpit session → allowed by the branch rule (still needs the ordinary allowlist, which `git rev-parse` clears).
    check(
      'cockpit session git rev-parse allowed',
      decide(decideArgs(cockpitPayload({ tool_input: { command: 'git rev-parse --abbrev-ref HEAD' } }), true)),
      'allow',
    );

    // The same checkout command, non-cockpit session → not denied by the branch rule; it still misses the ordinary allowlist, so 'miss', never 'deny' by this rule.
    check(
      'non-cockpit session git checkout',
      decide(decideArgs(cockpitPayload({ tool_input: { command: 'git checkout main' } }), false)),
      'miss',
    );

    // isCockpitSession: null (transcript unreadable) → unverifiable, allows — matching the gate rule's own null handling.
    check(
      'unreadable transcript git checkout',
      decide(decideArgs(cockpitPayload({ tool_input: { command: 'git checkout main' } }), null)),
      'miss',
    );

    // A subagent payload is never in scope for the branch rule — already deny/allow purely on the ordinary subagent rules.
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

    // An /port:implement impl-<n> operator worktree is exempt from the branch rule, same as the loop and gate rules.
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

    // The words "checkout the branch" quoted inside an unrelated argument must never trip the rule.
    check(
      'quoted checkout mention does not trip the rule',
      decide(decideArgs(cockpitPayload({ tool_input: { command: 'gh issue comment 5 -b "checkout the branch first"' } }), true)),
      'allow',
    );

    // switchesBranch itself, directly.
    expect(switchesBranch('git checkout main'), 'branch-rule-classifier', 'switchesBranch: expected true for "git checkout main"');
    expect(switchesBranch('git switch -c tmp'), 'branch-rule-classifier', 'switchesBranch: expected true for "git switch -c tmp"');
    expect(switchesBranch('git -C /repo checkout main'), 'branch-rule-classifier', 'switchesBranch: expected true for "git -C /repo checkout main"');
    expect(!switchesBranch('git rev-parse --abbrev-ref HEAD'), 'branch-rule-classifier', 'switchesBranch: expected false for a read-only git command');
    expect(!switchesBranch('gh pr checkout 5'), 'branch-rule-classifier', 'switchesBranch: expected false — this is gh, not git');

    // A chained command carrying an earlier, unrelated `git` invocation ahead of the checkout must still be caught — every command-position `git` occurrence is scanned, not just the first.
    expect(switchesBranch('git branch --sort=-committerdate ; git checkout evil-branch'), 'branch-rule-classifier', 'switchesBranch: expected true for a chained command with an earlier git invocation (spaced separator)');
    expect(switchesBranch('git branch --sort=-committerdate;git checkout evil-branch'), 'branch-rule-classifier', 'switchesBranch: expected true for a chained command with an earlier git invocation (unspaced separator)');
    expect(switchesBranch('git status && git checkout evil-branch'), 'branch-rule-classifier', 'switchesBranch: expected true for a chained command joined with &&');

    // A value-taking global flag like `-c` must not be mistaken for the git subcommand itself, or a cockpit session could slip a checkout past this rule.
    expect(switchesBranch('git -c core.editor=true checkout evil-branch'), 'branch-rule-classifier', 'switchesBranch: expected true for "git -c core.editor=true checkout evil-branch"');
    expect(!switchesBranch('git -c core.editor=true rebase --continue'), 'branch-rule-classifier', 'switchesBranch: expected false for "git -c core.editor=true rebase --continue"');

    // --- invokedCockpitSkill: the wrapper element is the whole tell — a bare mention of the skill name in prose must not trip it. ---
    expect(invokedCockpitSkill('<command-name>/port:pipeline</command-name>'), 'branch-rule-classifier', 'invokedCockpitSkill: expected true for the real wrapper form');
    expect(invokedCockpitSkill('<command-name>pipeline</command-name>'), 'branch-rule-classifier', 'invokedCockpitSkill: expected true with no namespace prefix');
    expect(!invokedCockpitSkill('Run /port:pipeline to start the cockpit.'), 'branch-rule-classifier', 'invokedCockpitSkill: expected false for a bare prose mention with no wrapper element');
    expect(!invokedCockpitSkill(''), 'branch-rule-classifier', 'invokedCockpitSkill: expected false for empty text');

    rmSync(classifierFixture, { recursive: true, force: true, maxRetries: 3 });
  }

  // --- End-to-end wiring: the real hook script, a temp JSONL transcript — proves the real
  // transcript read, not just the decision logic the classifier's own direct import cannot see. ---
  {
    const hookPath = join(root, 'plugins/port/hooks/agent-guard.mjs');
    const fixture = mkdtempSync(join(tmpdir(), 'port-guard-branch-hook-'));
    try {
      mkdirSync(join(fixture, '.claude'), { recursive: true });
      writeFileSync(join(fixture, '.claude', 'port.config.json'), '{"sessionRequiredPaths":["CLAUDE.md",".claude/**"]}');
      writeFileSync(join(fixture, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(git rev-parse *)'] } }));

      const transcriptFor = (text: string): string => {
        const p = join(fixture, 'transcript.jsonl');
        writeFileSync(p, [JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text }] } }), ''].join('\n'));
        return p;
      };
      const run = (payload: any) =>
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
      expect(!(lines.length !== 1 || !lines[0].includes('\tdeny\t')), 'branch-rule-hook-fixture', `expected exactly one 'deny' line, got ${JSON.stringify(lines)}`);

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
      expect(!(lines.length !== 2 || !lines[1].includes('\tmiss\t')), 'branch-rule-hook-fixture', `expected a 'miss' line (ordinary allowlist miss, not the branch rule), got ${JSON.stringify(lines)}`);
    } finally {
      rmSync(fixture, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  // --- The tell cannot be neutered by a shipped file naming it — a session that merely
  // reads a file carrying the literal `<command-name>` string must never look like a cockpit. ---
  {
    const shipped = walk(join(root, 'plugins/port')).filter((f) => f.endsWith('.md') || f.endsWith('.mjs'));
    for (const f of shipped) {
      expect(!readFileSync(f, 'utf8').includes('<command-name>'), 'preflight-tell-guard', `${relOf(f)} carries the literal '<command-name>' string — this would make any session that reads it look like a cockpit`);
    }
  }
}
