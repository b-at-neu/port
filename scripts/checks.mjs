#!/usr/bin/env node
// Layer 1 of the testing loop: deterministic checks over the plugin's files.
//
// No model calls, no dependencies, and no plugin install required — a
// dispatched agent's worktree may not resolve the plugin, so every check here
// works from files alone.
//
// This file only wires: it imports every topic module under scripts/checks/,
// awaits each in turn against the shared reporter, then reports. Check logic
// itself lives in the topic modules — never here, so the file stays thin no
// matter how many regression guards the topics below accumulate
// (scripts/checks/harness.mjs enforces this split mechanically).
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createReporter } from './lib/report.mjs';
import { root, walk } from './lib/files.mjs';
import { parseModule, renderIndex } from './lib/guards.mjs';

import components from './checks/components.mjs';
import shellDiscipline from './checks/shell-discipline.mjs';
import labelProtocol from './checks/label-protocol.mjs';
import standards from './checks/standards.mjs';
import hooks from './checks/hooks.mjs';
import allowlist from './checks/allowlist.mjs';
import config from './checks/config.mjs';
import install from './checks/install.mjs';
import release from './checks/release.mjs';
import labels from './checks/labels.mjs';
import artifacts from './checks/artifacts.mjs';
import docs from './checks/docs.mjs';
import evals from './checks/evals.mjs';
import cockpit from './checks/cockpit.mjs';
import preflight from './checks/preflight.mjs';
import budget from './checks/budget.mjs';
import reviewEvidence from './checks/review-evidence.mjs';
import harness from './checks/harness.mjs';
import guards from './checks/guards.mjs';
import desktopPlatform from './checks/desktop-platform.mjs';
import desktopRegistry from './checks/desktop-registry.mjs';
import desktopGithub from './checks/desktop-github.mjs';
import desktopSessions from './checks/desktop-sessions.mjs';
import desktopRenderer from './checks/desktop-renderer.mjs';
import desktopLocal from './checks/desktop-local.mjs';
import desktopReclaimer from './checks/desktop-reclaimer.mjs';
import desktopState from './checks/desktop-state.mjs';
import desktopWrites from './checks/desktop-writes.mjs';
import desktopBoard from './checks/desktop-board.mjs';
import desktopClaim from './checks/desktop-claim.mjs';
import desktopActions from './checks/desktop-actions.mjs';
import desktopSearch from './checks/desktop-search.mjs';
import fileSize from './checks/file-size.mjs';
import tick from './checks/tick.mjs';
import analyze from './checks/analyze.mjs';

// `--guards` is a second mode, not a check: it reads every topic module's own
// guard(#N) markers (scripts/checks/*.mjs → docs/TESTING.md's replacement for
// the single hub-file table, #217) and renders the index on demand — no
// fail/note/ok, no reporter, so scripts/checks/harness.mjs's split assertion
// still holds unchanged. `--issue <n>` narrows to entries citing that issue;
// a narrowed run that matches nothing is a failing answer, never a silent
// pass (docs/ENGINEERING.md §4).
const argv = process.argv.slice(2);
if (argv.includes('--guards')) {
  const files = walk(join(root, 'scripts/checks'))
    .filter((f) => f.endsWith('.mjs'))
    .sort();
  const entries = files.flatMap((f) => parseModule(readFileSync(f, 'utf8'), basename(f, '.mjs')));

  const issueFlagIdx = argv.indexOf('--issue');
  if (issueFlagIdx === -1) {
    process.stdout.write(renderIndex(entries));
  } else {
    const issue = Number(argv[issueFlagIdx + 1]);
    const matches = entries.filter((e) => e.issues?.includes(issue));
    if (matches.length === 0) {
      console.error(`No guard cites #${issue}.`);
      process.exitCode = 1;
    } else {
      process.stdout.write(renderIndex(matches));
    }
  }
} else {
  const reporter = createReporter();

  for (const module of [
    components,
    shellDiscipline,
    labelProtocol,
    standards,
    hooks,
    allowlist,
    config,
    install,
    release,
    labels,
    artifacts,
    docs,
    evals,
    cockpit,
    preflight,
    budget,
    reviewEvidence,
    harness,
    guards,
    desktopPlatform,
    desktopRegistry,
    desktopGithub,
    desktopSessions,
    desktopRenderer,
    desktopLocal,
    desktopReclaimer,
    desktopState,
    desktopWrites,
    desktopBoard,
    desktopClaim,
    desktopActions,
    desktopSearch,
    fileSize,
    tick,
    analyze,
  ]) {
    await module(reporter);
  }

  reporter.report();
}
