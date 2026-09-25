import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from '../lib/files.ts';
import { resolveMatchers, subagentPayload, plainPayload, operatorWorktreePayload, managedWorktreePayload, makeCheck } from '../lib/guard-fixtures.ts';
import type { Reporter } from '../lib/report.ts';

export default async function ({ fail, ok }: Reporter) {
  const { decide } = await import(pathToFileURL(join(root, 'plugins/port/hooks/lib/guard-rules.mjs')).href);
  const { pluginInstallMutation } = await import(pathToFileURL(join(root, 'plugins/port/hooks/lib/command-rules.mjs')).href);

  const matchers = resolveMatchers(fail);
  const check = makeCheck(fail, ok);

  // --- Cockpit rules: loop rule ------------------------------------------------
  // guard(#120): the cockpit losing everything but the first loop iteration when the turn dies mid-loop.

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

  // --- Cockpit rules: install rule ---------------------------------------------
  // guard(#144): an install from inside any managed worktree silently
  // repointing every session on the machine via the shared `installPath`,
  // and keeping doing so after that worktree is gone. Unlike the loop and
  // gate rules, this one does **not** exempt `impl-<n>` — the blast radius
  // is identical whether an operator or a dispatched agent typed it.

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
}
