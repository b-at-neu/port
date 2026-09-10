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
  const { allowMatchers, decide, bashPatternMatches, repoRelative } = await import(
    pathToFileURL(join(root, 'plugins/port/hooks/lib/guard-rules.mjs')).href
  );

  // --- Check A self-test — make it fail first ---------------------------------
  // The real historical failure, per ENGINEERING §7: a check that cannot be
  // made to fail is not a check. `bashPatternMatches` is called directly —
  // Check A's own matcher-wrapper shape is `allowMatchers`'s job to build, and
  // rebuilding it here would only re-derive fields nothing reads.
  {
    const narrowPattern = 'node scripts/checks.mjs';
    const wildcardPattern = 'node scripts/checks.mjs *';
    const bare = 'node scripts/checks.mjs';
    const suffixed = 'node scripts/checks.mjs 2>&1 | tail -100';

    if (!bashPatternMatches(narrowPattern, bare)) fail('allowlist-selftest', 'narrow entry should match the bare command');
    else ok();
    if (bashPatternMatches(narrowPattern, suffixed)) fail('allowlist-selftest', 'narrow entry should NOT match a suffixed command — self-test is broken');
    else ok();
    if (!bashPatternMatches(wildcardPattern, bare)) fail('allowlist-selftest', 'wildcarded entry should match the bare command');
    else ok();
    if (!bashPatternMatches(wildcardPattern, suffixed)) fail('allowlist-selftest', 'wildcarded entry should match a suffixed command');
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

  // --- Check C — repoRelative, called directly --------------------------------
  // Check B reaches this function only through `decide`, which can only ever
  // observe the allow/deny it feeds into. These cases assert the rewrite's own
  // documented contract — including the fail-closed arm, whose whole point is
  // that a declined path comes back byte-identical rather than reshaped into
  // the POSIX form the allow patterns are written in.
  {
    const rel = (label, command, configRoot, expected) => {
      const actual = repoRelative(command, configRoot);
      if (actual !== expected) {
        fail('allowlist-reporelative', `${label}: expected '${expected}', got '${actual}'`);
      } else {
        ok();
      }
    };

    const r = '/w/repo';

    // (1) The plain rewrite the wildcard entry is written against.
    rel('absolute in-root path becomes repo-relative', `node ${r}/scripts/checks.mjs`, r, 'node scripts/checks.mjs');

    // (2) The docstring's quoted-argument claim: surrounding quotes go with
    // the root prefix, because the allowlist matches the unquoted relative form.
    rel(
      'quoted absolute arguments lose their quotes with the root prefix',
      `node "${r}/templates/artifacts.mjs" check review "${r}/.temp/r.json"`,
      r,
      'node templates/artifacts.mjs check review .temp/r.json',
    );

    // (3) The docstring's "any other quoted span is left untouched" claim.
    rel(
      'a quoted span not containing the root is left untouched',
      `node ${r}/x.mjs --label "needs human"`,
      r,
      'node x.mjs --label "needs human"',
    );

    // (4) The docstring's `..`-escape claim — no root occurrence, so no rewrite.
    rel('a relative .. escape is returned byte-identical', 'node ../../elsewhere/checks.mjs', r, 'node ../../elsewhere/checks.mjs');

    // (5) The fail-closed arm's second effect, which used to leak: a
    // backslash-spelled command outside the root must come back exactly as
    // typed, never separator-normalized into something the POSIX-shaped allow
    // patterns could match.
    rel(
      'a backslash path outside the root is not separator-normalized',
      'node C:\\other\\scripts\\checks.mjs',
      r,
      'node C:\\other\\scripts\\checks.mjs',
    );

    // (6) A backslash-spelled path *inside* the root still resolves — the
    // normalization is a by-product of a real strip, which is the only way it
    // is ever reached.
    rel(
      'a backslash path inside the root still resolves',
      'node C:\\w\\repo\\scripts\\checks.mjs',
      'C:\\w\\repo',
      'node scripts/checks.mjs',
    );
  }

  // --- Check D — phrase pins ---------------------------------------------------
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
    if (!pipelineText.includes('fails toward availability')) {
      fail('allowlist-phrase-pin', `${pipelineRel} no longer states which direction the wildcard fails toward (ENGINEERING §4)`);
    } else {
      ok();
    }
  }

  // --- Check E — the prompt arm's own copies ------------------------------------
  // The prose #205 records as having lost this argument 18 times lives in three
  // stage prompts, so §2 needs it pinned: without this, the fix can be reverted
  // in one file with CI silent. The long clause is byte-identical between
  // impl-agent and revise-agent (both describe running commands.checks); the
  // review-agent variant says the same thing about commands.artifacts in its own
  // words, so only the two operative phrases are pinned across all three.
  {
    const runners = ['plugins/port/agents/impl-agent.md', 'plugins/port/agents/revise-agent.md'];
    const allThree = [...runners, 'plugins/port/agents/review-agent.md'];
    const texts = new Map(allThree.map((rel) => [rel, readFileSync(join(root, rel), 'utf8')]));

    for (const phrase of ['no pipe into `tail`/`head`/`grep`', 'no expansion to an absolute path']) {
      for (const rel of allThree) {
        if (!texts.get(rel).includes(phrase)) {
          fail('allowlist-prompt-pin', `${rel} no longer says "${phrase}" — the #205 prompt arm was reverted`);
        } else {
          ok();
        }
      }
    }

    // The shared clause, pinned byte-identical between its two copies rather
    // than only asserted present in each — a reworded copy is exactly the drift
    // §2 forbids.
    const CLAUSE =
      ': no `2>&1`, no pipe into `tail`/`head`/`grep` (#205 — the reporter prints one `ok` line or one `FAIL` line per failure, so there is nothing to truncate), and no expansion to an absolute path (the harness preamble\'s "use absolute file paths" is wrong for a `commands.*` invocation specifically — the allowlist entry is the repo-relative string, run it exactly as configured).';
    for (const rel of runners) {
      if (!texts.get(rel).includes(CLAUSE)) {
        fail('allowlist-prompt-pin', `${rel}'s commands.checks clause has drifted from its byte-identical counterpart`);
      } else {
        ok();
      }
    }
  }

  note('allowlist: commands.* coverage, normalization cases, repoRelative cases, and phrase pins (#205)');
}
