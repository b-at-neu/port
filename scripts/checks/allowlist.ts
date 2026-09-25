import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// Issue 205: 121 denials recorded against stage agents running their own
// configured commands.checks — 18 of them because the repository's own
// extraAllow entry for `node scripts/checks.ts` carried no trailing
// wildcard, so an agent limiting output (`2>&1 | tail -100`) missed the
// allowlist outright. This module makes that coverage mechanically checkable
// instead of a convention nobody re-verifies.
export default async function ({ fail, note, ok }: Reporter) {
  const { allowMatchers, decide, bashPatternMatches, repoRelative } = await import(
    pathToFileURL(join(root, 'plugins/port/hooks/lib/guard-rules.mjs')).href
  );

  // --- Check A self-test — make it fail first ---------------------------------
  // guard(#205): an extraAllow entry generated without a trailing ` *`,
  // denying every dispatched agent that limits a check's output. The real
  // historical failure, per ENGINEERING §7: a check that cannot be made to
  // fail is not a check. `bashPatternMatches` is called directly — Check A's
  // own matcher-wrapper shape is `allowMatchers`'s job to build, and
  // rebuilding it here would only re-derive fields nothing reads.
  {
    const narrowPattern = 'node scripts/checks.ts';
    const wildcardPattern = 'node scripts/checks.ts *';
    const bare = 'node scripts/checks.ts';
    const suffixed = 'node scripts/checks.ts 2>&1 | tail -100';

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

  // --- Check A' — a preexisting bare entry is never replaced by its wildcard --
  // guard(#212): a wildcard silently replacing a preexisting bare entry
  // instead of joining it — functional matching alone can't tell the two
  // states apart, since a wildcard-only entry already satisfies both (R3-M1).
  // A wildcard entry alone already satisfies Check A's functional bare/suffix
  // match above, so it cannot by itself catch a bare entry silently dropped
  // when the wildcard was added alongside it — exactly what happened once:
  // issue 205's fix removed `Bash(node scripts/checks.ts)` instead of
  // keeping it. `init/SKILL.md`'s reconcile rule says the wildcard form is
  // "added alongside it — never removed", matching the paired bare/wildcard
  // convention every other bare-invocable command in permissions.base.json
  // already follows. Asserted as literal string presence, not functional
  // matching, since functional matching is exactly what cannot distinguish
  // the two states here.
  {
    const checkCommand = readJson('.claude/port.config.json').commands?.checks?.[0]?.run;
    if (typeof checkCommand === 'string') {
      const bareEntry = `"Bash(${checkCommand})"`;
      const wildcardEntry = `"Bash(${checkCommand} *)"`;
      for (const rel of ['.claude/settings.json', '.claude/port.config.json']) {
        const text = readFileSync(join(root, rel), 'utf8');
        if (!text.includes(bareEntry)) {
          fail('allowlist-paired-entry', `${rel} is missing the bare entry ${bareEntry} — the wildcard must never replace it (#212)`);
        } else {
          ok();
        }
        if (!text.includes(wildcardEntry)) {
          fail('allowlist-paired-entry', `${rel} is missing the wildcard entry ${wildcardEntry}`);
        } else {
          ok();
        }
      }
    }
  }

  // --- Check B — classifier cases for normalization ---------------------------
  // guard(#205): the guard denying an agent's own configured command merely
  // because the harness expanded it to an absolute path. Each case names the
  // failure it catches, mirroring hooks.ts's own "Guard hook classifier"
  // style.
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
      if (result.decision !== expected) {
        fail('allowlist-normalization', `${label}: expected '${expected}', got '${result.decision}'`);
      } else {
        ok();
      }
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

  // --- Check C — repoRelative, called directly --------------------------------
  // guard(#205): the fail-closed arm silently reshaping a declined path into
  // the POSIX form the allow patterns are written in, widening the match.
  // Check B reaches this function only through `decide`, which can only ever
  // observe the allow/deny it feeds into. These cases assert the rewrite's
  // own documented contract, including the fail-closed arm, whose whole
  // point is that a declined path comes back byte-identical.
  {
    const rel = (label: string, command: string, configRoot: string, expected: string): void => {
      const actual = repoRelative(command, configRoot);
      if (actual !== expected) {
        fail('allowlist-reporelative', `${label}: expected '${expected}', got '${actual}'`);
      } else {
        ok();
      }
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

    // (5) The fail-closed arm's second effect, which used to leak: a
    // backslash-spelled command outside the root must come back exactly as
    // typed, never separator-normalized into something the POSIX-shaped allow
    // patterns could match.
    rel(
      'a backslash path outside the root is not separator-normalized',
      'node C:\\other\\scripts\\checks.ts',
      r,
      'node C:\\other\\scripts\\checks.ts',
    );

    // (6) A backslash-spelled path *inside* the root still resolves — the
    // normalization is a by-product of a real strip, which is the only way it
    // is ever reached.
    rel(
      'a backslash path inside the root still resolves',
      'node C:\\w\\repo\\scripts\\checks.ts',
      'C:\\w\\repo',
      'node scripts/checks.ts',
    );
  }

  // --- Check D — phrase pins ---------------------------------------------------
  // guard(#205): the prompt arm of the fix being reverted in one file with
  // CI silent — PIPELINE.md must still name which direction the trailing
  // wildcard fails toward. A future prose edit that quietly reverts either
  // rule fails here rather than in a live pipeline run.
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
  // guard(#205): the prompt arm of the fix being reverted in one file with
  // CI silent. The prose issue 205 records as having lost this argument 18
  // times lives in three stage prompts, so §2 needs it pinned. The long
  // clause is byte-identical between impl-agent and revise-agent (both
  // describe running commands.checks); the review-agent variant says the
  // same thing about commands.artifacts in its own words, so only the two
  // operative phrases are pinned across all three.
  {
    const runners = ['plugins/port/agents/impl-agent.md', 'plugins/port/agents/revise-agent.md'];
    const allThree = [...runners, 'plugins/port/agents/review-agent.md'];
    const texts = new Map<string, string>(allThree.map((rel) => [rel, readFileSync(join(root, rel), 'utf8')]));

    for (const phrase of ['no pipe into `tail`/`head`/`grep`', 'no expansion to an absolute path']) {
      for (const rel of allThree) {
        if (!texts.get(rel)?.includes(phrase)) {
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
      if (!texts.get(rel)?.includes(CLAUSE)) {
        fail('allowlist-prompt-pin', `${rel}'s commands.checks clause has drifted from its byte-identical counterpart`);
      } else {
        ok();
      }
    }
  }

  // --- Check F — what actually bounds the wildcard ------------------------------
  // guard(#212): the trailing wildcard's fail-toward-availability argument
  // resting on the deny list, which keys off a command's leading tokens and
  // so cannot fire on anything chained after a matched prefix. Both prose
  // copies used to rest the argument on "the deny list stays the real safety
  // surface for whatever gets chained after it", which is false. What makes
  // the widening bounded is that the guard hook is **deny-only**: it can add
  // a denial but never grant one, so a wildcard entry widens only what the
  // hook declines to object to. That is a property of the shipped hook, so
  // it is asserted against the hook itself rather than trusted as prose, and
  // the two prose copies are pinned to state it.
  {
    const hookRel = 'plugins/port/hooks/agent-guard.mjs';
    const hookText = readFileSync(join(root, hookRel), 'utf8');
    // The hook's own header comment spells `permissionDecision: "deny"` in
    // prose, so matching the raw file left `emitted` non-empty even with the
    // real emission deleted — the presence assertion below reported green while
    // looping over a comment (ENGINEERING §7, "a check must be able to
    // distinguish the state it exists to detect"). Only whole-line and block
    // comments are stripped: a trailing `//` strip would truncate any code line
    // holding a `//` inside a string literal, and a stray decision spelled in a
    // trailing comment failing this check errs toward the safe direction.
    const hookCode = hookText
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    const emitted = [...hookCode.matchAll(/permissionDecision:\s*['"]([^'"]*)['"]/g)].map((m) => m[1]);
    if (emitted.length === 0) {
      fail('allowlist-deny-only', `${hookRel} emits no permissionDecision at all — the deny-only property is unverifiable`);
    } else {
      ok();
    }
    for (const value of emitted) {
      if (value !== 'deny') {
        fail(
          'allowlist-deny-only',
          `${hookRel} emits permissionDecision '${value}' — the hook must stay deny-only, or the trailing wildcard (#205) starts granting rather than merely not objecting`,
        );
      } else {
        ok();
      }
    }

    const copies: [string, string[]][] = [
      ['plugins/port/docs/PIPELINE.md', ['the guard hook is deny-only', 'it is not the deny list that bounds it', 'residual gap, stated plainly']],
      ['plugins/port/templates/permissions.base.json', ['The guard hook is deny-only', 'What bounds it is NOT the deny list', 'Residual gap, stated']],
    ];
    for (const [rel, phrases] of copies) {
      const text = readFileSync(join(root, rel), 'utf8');
      for (const phrase of phrases) {
        if (!text.includes(phrase)) {
          fail('allowlist-deny-only', `${rel} no longer says "${phrase}" — #212's correction to what bounds the wildcard was reverted`);
        } else {
          ok();
        }
      }
    }
  }

  // --- Check G — the Skill delivery path, both directions ---------------------
  // guard(#50): a skill-only plugin could not reach a dispatched agent because
  // Skill was absent from the template, this repository's own settings, and
  // the two read-only agents' tools: — recommending a capability the
  // pipeline could not deliver. Same shape as Check A': asserted in both
  // directions, since three of four carrying it is the half-live state that
  // recommends a benefit the agents do not actually have.
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
    if (!pipelineText.includes('the repository itself declares')) {
      fail('allowlist-skill-delivery', `${pipelineRel} no longer states the Skill grant's bound ("...the repository itself declares")`);
    } else {
      ok();
    }
  }

  note('allowlist: commands.* coverage, normalization cases, repoRelative cases, phrase pins (#205), the deny-only bound (#212), and the Skill delivery path (#50)');
}
