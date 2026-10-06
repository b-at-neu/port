import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// Makes extraAllow coverage for commands.* mechanically checkable, so an entry missing its
// trailing wildcard (denying any agent that limits a check's output) is caught, not a convention nobody re-verifies.
export default async function ({ expect, fail, note, ok }: Reporter) {
  const { allowMatchers, decide, bashPatternMatches, repoRelative } = await import(
    pathToFileURL(join(root, 'plugins/port/hooks/lib/guard-rules.mjs')).href
  );

  // --- Check A self-test: an extraAllow entry without a trailing ` *` denies every agent
  // that limits a check's output. `bashPatternMatches` is called directly, not rebuilt. ---
  {
    const narrowPattern = 'node scripts/checks.ts';
    const wildcardPattern = 'node scripts/checks.ts *';
    const bare = 'node scripts/checks.ts';
    const suffixed = 'node scripts/checks.ts 2>&1 | tail -100';

    expect(bashPatternMatches(narrowPattern, bare), 'allowlist-selftest', 'narrow entry should match the bare command');
    expect(!bashPatternMatches(narrowPattern, suffixed), 'allowlist-selftest', 'narrow entry should NOT match a suffixed command — self-test is broken');
    expect(bashPatternMatches(wildcardPattern, bare), 'allowlist-selftest', 'wildcarded entry should match the bare command');
    expect(bashPatternMatches(wildcardPattern, suffixed), 'allowlist-selftest', 'wildcarded entry should match a suffixed command');
  }

  // --- Check A — commands.* coverage ------------------------------------------
  // Every configured command must match the allowlist both bare and with a probe suffix.
  {
    const settingsFiles = ['.claude/settings.json', '.claude/settings.local.json'].map((f) => join(root, f));
    const matchers = allowMatchers(settingsFiles);
    if (matchers === null) {
      fail('allowlist-coverage', 'no Bash allow entries found in .claude/settings.json or .claude/settings.local.json');
    } else {
      const cfg = readJson('.claude/port.config.json');
      const commands: string[] = [
        ...(cfg.commands?.bootstrap ?? []),
        ...(cfg.commands?.checks ?? []).map((e: any) => e.run),
        ...(cfg.commands?.checks ?? []).map((e: any) => e.fix).filter((f: any) => typeof f === 'string'),
        cfg.commands?.artifacts,
        cfg.commands?.worktrees,
        cfg.release?.postPublishHook,
      ].filter((c) => typeof c === 'string' && c.length > 0);

      const probe = '2>&1 | tail -100';
      for (const command of commands) {
        const bareMatch = matchers.some((m: any) => m.test(command));
        if (!bareMatch) {
          fail('allowlist-coverage', `'${command}' matches no allow entry at all — add "Bash(${command} *)" to extraAllow`);
          continue;
        }
        ok();
        const suffixMatch = matchers.some((m: any) => m.test(`${command} ${probe}`));
        expect(suffixMatch, 'allowlist-coverage', `'${command}' matches only the bare form — its allow entry needs a trailing ' *': "Bash(${command} *)"`);
      }
    }
  }

  // --- Check A' — a preexisting bare entry is never replaced by its wildcard: asserted as
  // literal string presence, since functional matching can't tell a dropped bare entry from a kept one. ---
  {
    const checkCommand = readJson('.claude/port.config.json').commands?.checks?.[0]?.run;
    if (typeof checkCommand === 'string') {
      const bareEntry = `"Bash(${checkCommand})"`;
      const wildcardEntry = `"Bash(${checkCommand} *)"`;
      for (const rel of ['.claude/settings.json', '.claude/port.config.json']) {
        const text = readFileSync(join(root, rel), 'utf8');
        expect(text.includes(bareEntry), 'allowlist-paired-entry', `${rel} is missing the bare entry ${bareEntry} — the wildcard must never replace it (#212)`);
        expect(text.includes(wildcardEntry), 'allowlist-paired-entry', `${rel} is missing the wildcard entry ${wildcardEntry}`);
      }
    }
  }

  // --- Check B — classifier cases for normalization: the guard must not deny an agent's own
  // configured command merely because the harness expanded it to an absolute path. ---
  {
    const settingsFile = join(root, '.claude/settings.json');
    const matchers = allowMatchers([settingsFile]);
    const subagentPayload = (command: string, cwd = join(root, '.claude/worktrees/agent-fixture205')): any => ({
      cwd,
      session_id: 'sess-205',
      agent_type: 'impl-agent',
      agent_id: 'agent-205',
      tool_name: 'Bash',
      tool_input: { command },
    });

    const check = (label: string, result: any, expected: string): void => {
      expect(!(result.decision !== expected), 'allowlist-normalization', `${label}: expected '${expected}', got '${result.decision}'`);
    };

    // (1) A subagent's absolute in-worktree invocation of the configured
    // checks command is allowed under its wildcarded entry.
    check(
      'absolute worktree checks.ts invocation is allowed',
      decide({
        payload: subagentPayload(`node ${root}/scripts/checks.ts`),
        matchers,
        sessionRequiredPaths: [],
        root,
      }),
      'allow',
    );

    // (2) The real historical denial — an absolute artifacts.mjs invocation
    // with quoted arguments — is allowed under its already-wildcarded entry.
    check(
      'absolute artifacts.mjs invocation with quoted args is allowed',
      decide({
        payload: subagentPayload(
          `node "${root}/plugins/port/bin/artifacts.mjs" check review "${root}/.temp/r.json" --cycle 2`,
        ),
        matchers,
        sessionRequiredPaths: [],
        root,
      }),
      'allow',
    );

    // (3) A path outside the configured root is left unresolved and still misses.
    check(
      'invocation outside the configured root still misses',
      decide({
        payload: subagentPayload('node /tmp/elsewhere/scripts/checks.ts'),
        matchers,
        sessionRequiredPaths: [],
        root,
      }),
      'deny',
    );

    // (4) Normalization never manufactures a match for a non-allowlisted binary.
    check(
      'a non-allowlisted binary is still denied',
      decide({
        payload: subagentPayload(`rm -rf ${root}/src`),
        matchers,
        sessionRequiredPaths: [],
        root,
      }),
      'deny',
    );

    // (5) The same as (1), spelled with Windows path separators.
    check(
      'Windows-separated absolute invocation is allowed',
      decide({
        payload: subagentPayload(`node ${root.split('/').join('\\')}\\scripts\\checks.ts`),
        matchers,
        sessionRequiredPaths: [],
        root,
      }),
      'allow',
    );
  }

  // --- Check C — repoRelative, called directly: asserts the rewrite's documented contract,
  // including the fail-closed arm, whose point is that a declined path comes back byte-identical. ---
  {
    const rel = (label: string, command: string, configRoot: string, expected: string): void => {
      const actual = repoRelative(command, configRoot);
      expect(!(actual !== expected), 'allowlist-reporelative', `${label}: expected '${expected}', got '${actual}'`);
    };

    const r = '/w/repo';

    // (1) The plain rewrite the wildcard entry is written against.
    rel('absolute in-root path becomes repo-relative', `node ${r}/scripts/checks.ts`, r, 'node scripts/checks.ts');

    // (2) The docstring's quoted-argument claim: surrounding quotes go with
    // the root prefix, because the allowlist matches the unquoted relative form.
    rel(
      'quoted absolute arguments lose their quotes with the root prefix',
      `node "${r}/bin/artifacts.ts" check review "${r}/.temp/r.json"`,
      r,
      'node bin/artifacts.ts check review .temp/r.json',
    );

    // (3) The docstring's "any other quoted span is left untouched" claim.
    rel(
      'a quoted span not containing the root is left untouched',
      `node ${r}/x.ts --label "needs human"`,
      r,
      'node x.ts --label "needs human"',
    );

    // (4) The docstring's `..`-escape claim — no root occurrence, so no rewrite.
    rel('a relative .. escape is returned byte-identical', 'node ../../elsewhere/checks.ts', r, 'node ../../elsewhere/checks.ts');

    // (5) A backslash-spelled command outside the root must come back exactly as typed, never separator-normalized.
    rel(
      'a backslash path outside the root is not separator-normalized',
      'node C:\\other\\scripts\\checks.ts',
      r,
      'node C:\\other\\scripts\\checks.ts',
    );

    // (6) A backslash-spelled path inside the root still resolves — a by-product of a real strip.
    rel(
      'a backslash path inside the root still resolves',
      'node C:\\w\\repo\\scripts\\checks.ts',
      'C:\\w\\repo',
      'node scripts/checks.ts',
    );
  }

  // --- Check D — phrase pins: PIPELINE.md must still name which direction the trailing
  // wildcard fails toward, so a reverting prose edit fails here rather than in a live run. ---
  {
    const skillRel = 'plugins/port/skills/init/SKILL.md';
    const skillText = readFileSync(join(root, skillRel), 'utf8');
    expect(skillText.includes('carries a trailing ` *`, never the bare form'), 'allowlist-phrase-pin', `${skillRel} no longer states the trailing-wildcard rule`);

    const pipelineRel = 'plugins/port/docs/PIPELINE.md';
    const pipelineText = readFileSync(join(root, pipelineRel), 'utf8');
    expect(pipelineText.includes('carries a trailing ` *`'), 'allowlist-phrase-pin', `${pipelineRel} no longer states the trailing-wildcard rule`);
    expect(pipelineText.includes('resolves an in-repo absolute invocation to its repo-relative form'), 'allowlist-phrase-pin', `${pipelineRel} no longer names the root-normalization behaviour`);
    expect(pipelineText.includes('fails toward availability'), 'allowlist-phrase-pin', `${pipelineRel} no longer states which direction the wildcard fails toward (ENGINEERING §4)`);
  }

  // --- Check E — the prompt arm's own copies: the long clause is byte-identical between
  // impl-agent and revise-agent; review-agent says the same about commands.artifacts in its own words, so only the two operative phrases are pinned across all three. ---
  {
    const runners = ['plugins/port/agents/impl-agent.md', 'plugins/port/agents/revise-agent.md'];
    const allThree = [...runners, 'plugins/port/agents/review-agent.md'];
    const texts = new Map<string, string>(allThree.map((rel) => [rel, readFileSync(join(root, rel), 'utf8')]));

    for (const phrase of ['no pipe into `tail`/`head`/`grep`', 'no expansion to an absolute path']) {
      for (const rel of allThree) {
        expect(texts.get(rel)?.includes(phrase), 'allowlist-prompt-pin', `${rel} no longer says "${phrase}" — the #205 prompt arm was reverted`);
      }
    }

    // The shared clause, pinned byte-identical between its two copies — a reworded copy is the drift to forbid.
    const CLAUSE =
      ': no `2>&1`, no pipe into `tail`/`head`/`grep` (#205 — the reporter prints one `ok` line or one `FAIL` line per failure, so there is nothing to truncate), and no expansion to an absolute path (the harness preamble\'s "use absolute file paths" is wrong for a `commands.*` invocation specifically — the allowlist entry is the repo-relative string, run it exactly as configured).';
    for (const rel of runners) {
      expect(texts.get(rel)?.includes(CLAUSE), 'allowlist-prompt-pin', `${rel}'s commands.checks clause has drifted from its byte-identical counterpart`);
    }
  }

  // --- Check F — what actually bounds the wildcard: the guard hook is deny-only, so a
  // wildcard entry widens only what the hook declines to object to — asserted against the hook itself, not trusted as prose. ---
  {
    const hookRel = 'plugins/port/hooks/agent-guard.mjs';
    const hookText = readFileSync(join(root, hookRel), 'utf8');
    // Only whole-line and block comments are stripped, never a trailing `//`, which would
    // truncate a code line holding one inside a string literal.
    const hookCode = hookText
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    const emitted = [...hookCode.matchAll(/permissionDecision:\s*['"]([^'"]*)['"]/g)].map((m) => m[1]);
    expect(!(emitted.length === 0), 'allowlist-deny-only', `${hookRel} emits no permissionDecision at all — the deny-only property is unverifiable`);
    for (const value of emitted) {
      expect(!(value !== 'deny'), 'allowlist-deny-only', `${hookRel} emits permissionDecision '${value}' — the hook must stay deny-only, or the trailing wildcard (#205) starts granting rather than merely not objecting`);
    }

    const copies: [string, string[]][] = [
      ['plugins/port/docs/PIPELINE.md', ['the guard hook is deny-only', 'it is not the deny list that bounds it', 'residual gap, stated plainly']],
      ['plugins/port/templates/permissions.base.json', ['The guard hook is deny-only', 'What bounds it is NOT the deny list', 'Residual gap, stated']],
    ];
    for (const [rel, phrases] of copies) {
      const text = readFileSync(join(root, rel), 'utf8');
      for (const phrase of phrases) {
        expect(text.includes(phrase), 'allowlist-deny-only', `${rel} no longer says "${phrase}" — #212's correction to what bounds the wildcard was reverted`);
      }
    }
  }

  // --- Check G — the Skill delivery path, both directions: three of four carriers having it
  // is the half-live state that recommends a benefit the agents do not actually have. ---
  {
    function frontmatterOf(text: string): Record<string, string> | null {
      const m = /^---\n([\s\S]*?)\n---/.exec(text);
      if (!m) return null;
      const out: Record<string, string> = {};
      for (const line of m[1].split('\n')) {
        const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
        if (kv) out[kv[1]] = kv[2].trim();
      }
      return out;
    }

    const carriers: [string, (text: string) => boolean][] = [
      ['plugins/port/templates/permissions.base.json', (text) => text.includes('"Skill"')],
      ['.claude/settings.json', (text) => text.includes('"Skill"')],
      ['plugins/port/agents/plan-agent.md', (text) => (frontmatterOf(text)?.tools ?? '').split(',').map((t) => t.trim()).includes('Skill')],
      ['plugins/port/agents/review-agent.md', (text) => (frontmatterOf(text)?.tools ?? '').split(',').map((t) => t.trim()).includes('Skill')],
    ];

    const results: [string, boolean][] = carriers.map(([rel, test]) => [rel, test(readFileSync(join(root, rel), 'utf8'))]);
    const present = results.filter(([, has]) => has);
    const missing = results.filter(([, has]) => !has);

    if (present.length > 0 && missing.length > 0) {
      for (const [rel] of missing) {
        fail(
          'allowlist-skill-delivery',
          `${rel} is missing the Skill grant while ${present.map(([r]) => r).join(', ')} carr${present.length === 1 ? 'ies' : 'y'} it — the delivery path is half-live`,
        );
      }
    } else {
      ok();
    }

    const pipelineRel = 'plugins/port/docs/PIPELINE.md';
    const pipelineText = readFileSync(join(root, pipelineRel), 'utf8');
    expect(pipelineText.includes('the repository itself declares'), 'allowlist-skill-delivery', `${pipelineRel} no longer states the Skill grant's bound ("...the repository itself declares")`);
  }

  note('allowlist: commands.* coverage, normalization cases, repoRelative cases, phrase pins (#205), the deny-only bound (#212), and the Skill delivery path (#50)');
}
