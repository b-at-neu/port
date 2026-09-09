import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson } from '../lib/files.mjs';

// Regression guard for #205: 121 denials recorded against stage agents
// running their own configured commands.checks — 18 of them because the
// repository's own extraAllow entry for `node scripts/checks.mjs` carried no
// trailing wildcard, so an agent limiting output (`2>&1 | tail -100`) missed
// the allowlist outright. This module makes that coverage mechanically
// checkable instead of a convention nobody re-verifies.
export default async function ({ fail, note, ok }) {
  const { allowMatchers, decide, bashPatternMatches } = await import(
    pathToFileURL(join(root, 'plugins/port/hooks/lib/guard-rules.mjs')).href
  );

  // --- Check A self-test — make it fail first ---------------------------------
  // The real historical failure, per ENGINEERING §7: a check that cannot be
  // made to fail is not a check.
  {
    const narrow = ['Bash(node scripts/checks.mjs)'].map((pattern) => ({
      tool: 'Bash',
      pattern,
      test: (command) => bashPatternMatches(pattern.slice('Bash('.length, -1), command),
    }));
    const wildcarded = ['Bash(node scripts/checks.mjs *)'].map((pattern) => ({
      tool: 'Bash',
      pattern,
      test: (command) => bashPatternMatches(pattern.slice('Bash('.length, -1), command),
    }));
    const bare = 'node scripts/checks.mjs';
    const suffixed = 'node scripts/checks.mjs 2>&1 | tail -100';

    if (!narrow.some((m) => m.test(bare))) fail('allowlist-selftest', 'narrow entry should match the bare command');
    else ok();
    if (narrow.some((m) => m.test(suffixed))) fail('allowlist-selftest', 'narrow entry should NOT match a suffixed command — self-test is broken');
    else ok();
    if (!wildcarded.some((m) => m.test(bare))) fail('allowlist-selftest', 'wildcarded entry should match the bare command');
    else ok();
    if (!wildcarded.some((m) => m.test(suffixed))) fail('allowlist-selftest', 'wildcarded entry should match a suffixed command');
    else ok();
  }

  // --- Check A — commands.* coverage ------------------------------------------
  // Every command this repository configures must match the allowlist both
  // bare and with a probe suffix — the second is what forces the wildcard.
  {
    const settingsFiles = ['.claude/settings.json', '.claude/settings.local.json'].map((f) => join(root, f));
    const matchers = allowMatchers(settingsFiles);
    if (matchers === null) {
      fail('allowlist-coverage', 'no Bash allow entries found in .claude/settings.json or .claude/settings.local.json');
    } else {
      const cfg = readJson('.claude/port.config.json');
      const commands = [
        ...(cfg.commands?.bootstrap ?? []),
        ...(cfg.commands?.checks ?? []).map((e) => e.run),
        ...(cfg.commands?.checks ?? []).map((e) => e.fix).filter((f) => typeof f === 'string'),
        cfg.commands?.artifacts,
        cfg.commands?.worktrees,
      ].filter((c) => typeof c === 'string' && c.length > 0);

      const probe = '2>&1 | tail -100';
      for (const command of commands) {
        const bareMatch = matchers.some((m) => m.test(command));
        if (!bareMatch) {
          fail('allowlist-coverage', `'${command}' matches no allow entry at all — add "Bash(${command} *)" to extraAllow`);
          continue;
        }
        ok();
        const suffixMatch = matchers.some((m) => m.test(`${command} ${probe}`));
        if (!suffixMatch) {
          fail(
            'allowlist-coverage',
            `'${command}' matches only the bare form — its allow entry needs a trailing ' *': "Bash(${command} *)"`,
          );
        } else {
          ok();
        }
      }
    }
  }

  // --- Check B — classifier cases for normalization ---------------------------
  // Each case names the failure it catches, mirroring hooks.mjs's own
  // "Guard hook classifier" style.
  {
    const settingsFile = join(root, '.claude/settings.json');
    const matchers = allowMatchers([settingsFile]);
    const subagentPayload = (command, cwd = join(root, '.claude/worktrees/agent-fixture205')) => ({
      cwd,
      session_id: 'sess-205',
      agent_type: 'impl-agent',
      agent_id: 'agent-205',
      tool_name: 'Bash',
      tool_input: { command },
    });

    const check = (label, result, expected) => {
      if (result.decision !== expected) {
        fail('allowlist-normalization', `${label}: expected '${expected}', got '${result.decision}'`);
      } else {
        ok();
      }
    };

    // (1) A subagent's absolute in-worktree invocation of the configured
    // checks command is allowed under its wildcarded entry.
    check(
      'absolute worktree checks.mjs invocation is allowed',
      decide({
        payload: subagentPayload(`node ${root}/scripts/checks.mjs`),
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
          `node "${root}/plugins/port/templates/artifacts.mjs" check review "${root}/.temp/r.json" --cycle 2`,
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
        payload: subagentPayload('node /tmp/elsewhere/scripts/checks.mjs'),
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
        payload: subagentPayload(`node ${root.split('/').join('\\')}\\scripts\\checks.mjs`),
        matchers,
        sessionRequiredPaths: [],
        root,
      }),
      'allow',
    );
  }

  // --- Check C — phrase pins ---------------------------------------------------
  // A future prose edit that quietly reverts either rule fails here rather
  // than in a live pipeline run.
  {
    const skillRel = 'plugins/port/skills/init/SKILL.md';
    const skillText = readFileSync(join(root, skillRel), 'utf8');
    if (!skillText.includes('carries a trailing ` *`, never the bare form')) {
      fail('allowlist-phrase-pin', `${skillRel} no longer states the trailing-wildcard rule`);
    } else {
      ok();
    }

    const pipelineRel = 'plugins/port/docs/PIPELINE.md';
    const pipelineText = readFileSync(join(root, pipelineRel), 'utf8');
    if (!pipelineText.includes('carries a trailing ` *`')) {
      fail('allowlist-phrase-pin', `${pipelineRel} no longer states the trailing-wildcard rule`);
    } else {
      ok();
    }
    if (!pipelineText.includes('resolves an in-repo absolute invocation to its repo-relative form')) {
      fail('allowlist-phrase-pin', `${pipelineRel} no longer names the root-normalization behaviour`);
    } else {
      ok();
    }
  }

  note('allowlist: commands.* coverage, normalization cases, and phrase pins (#205)');
}
