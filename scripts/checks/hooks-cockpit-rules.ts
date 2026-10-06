import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from '../lib/files.ts';
import { resolveMatchers, subagentPayload, plainPayload, operatorWorktreePayload, managedWorktreePayload, makeCheck, makeDecide, bash } from '../lib/guard-fixtures.ts';
import type { Reporter } from '../lib/report.ts';

export default async function ({ fail, ok, expect }: Reporter) {
  const { decide } = await import(pathToFileURL(join(root, 'plugins/port/hooks/lib/guard-rules.mjs')).href);
  const { pluginInstallMutation } = await import(pathToFileURL(join(root, 'plugins/port/hooks/lib/command-rules.mjs')).href);

  const matchers = resolveMatchers(fail);
  const check = makeCheck(fail, ok);
  const gate = makeDecide(decide, { matchers, sessionRequiredPaths: [], root });

  // --- Cockpit rules: loop rule ------------------------------------------------
  // guard(#120): the cockpit losing everything but the first loop iteration when the turn dies mid-loop.

  // The #120 loop, from a plain (cockpit) session → denied.
  check(
    '#120 loop from a plain session',
    gate({
      payload: bash('for n in 63 67 71; do gh issue edit $n --repo b-at-neu/port --remove-label "planning" --add-label "ready"; done'),
    }),
    'deny',
  );

  // The same command from an impl-<n> operator worktree → never denied by
  // the cockpit loop rule. It still misses the ordinary allowlist (a raw
  // shell `for` is not `gh ...`), so the outcome is 'miss', never 'deny' —
  // this asserts the *reason* changed, not that the command became
  // allowlisted.
  {
    const result = gate({
      payload: bash('for n in 63 67 71; do gh issue edit $n --repo b-at-neu/port --remove-label "planning" --add-label "ready"; done', operatorWorktreePayload),
    });
    expect(
      result.decision !== 'deny',
      'guard-classifier',
      `#120 loop from an impl-<n> operator worktree: expected not 'deny' (cockpit rules are inert there), got 'deny'`,
    );
  }

  // The sanctioned batched form — no loop — from a plain session → allowed.
  check(
    'batched multi-item gh issue edit, no loop',
    gate({ payload: bash('gh issue edit 63 67 71 --repo b-at-neu/port --add-label "ready"') }),
    'allow',
  );

  // A loop over a command that is neither gh nor git → miss, never deny —
  // the loop rule only targets gh/git.
  check(
    'loop with no gh/git target',
    gate({ payload: bash('for i in 1 2 3; do echo $i; done') }),
    'miss',
  );

  // Loop keywords quoted inside a `-b` argument must never trip the rule —
  // this is the quote-stripping regression.
  check(
    'loop keywords inside a quoted argument are not a loop',
    gate({ payload: bash('gh issue comment 5 -b "a loop for each item to do"') }),
    'allow',
  );

  // --- Cockpit rules: install rule ---------------------------------------------
  // guard(#144): an install from inside any managed worktree silently
  // repointing every session on the machine via the shared `installPath`,
  // and keeping doing so after that worktree is gone. Unlike the loop and
  // gate rules, this one does **not** exempt `impl-<n>` — the blast radius
  // is identical whether an operator or a dispatched agent typed it.

  check(
    'install from a dispatched-agent worktree is denied',
    gate({ payload: bash('claude plugin install port@port --scope local', subagentPayload) }),
    'deny',
  );

  check(
    'install from a plain session inside a managed worktree is denied',
    gate({ payload: bash('claude plugin install port@port --scope local', managedWorktreePayload) }),
    'deny',
  );

  // The one cockpit-class rule that does NOT exempt impl-<n> — an install
  // performed from an /port:implement operator worktree repoints every
  // session on the machine exactly as one from a dispatched agent's
  // worktree would.
  check(
    'install from an impl-<n> operator worktree is still denied',
    gate({ payload: bash('claude plugin marketplace add /abs/path --scope local', operatorWorktreePayload) }),
    'deny',
  );

  check(
    // 'claude' is not on this repository's Bash allowlist at all, so the
    // install rule not firing here surfaces as 'miss' (a normal permission
    // prompt), never 'deny' — the point is that the install rule itself
    // does not add a denial outside a managed worktree, not that the
    // command is allowlisted.
    'install from the main checkout is not denied by the install rule',
    gate({ payload: bash('claude plugin install port@port --scope local') }),
    'miss',
  );

  check(
    'read-only plugin subcommand from a managed worktree is not denied by the install rule',
    gate({ payload: bash('claude plugin list', managedWorktreePayload) }),
    'miss',
  );

  check(
    'the words "plugin install" quoted inside an unrelated argument do not trip the rule',
    gate({ payload: bash('gh issue comment 5 -b "please run claude plugin install port manually"', managedWorktreePayload) }),
    'allow',
  );

  // pluginInstallMutation itself, directly.
  {
    expect(pluginInstallMutation('claude plugin install port@port --scope local'), 'guard-classifier', 'pluginInstallMutation: expected true for "claude plugin install"');
    expect(pluginInstallMutation('claude plugin marketplace add /abs/path --scope local'), 'guard-classifier', 'pluginInstallMutation: expected true for "claude plugin marketplace add"');
    expect(!pluginInstallMutation('claude plugin details port'), 'guard-classifier', 'pluginInstallMutation: expected false for a read-only subcommand');
  }
}
