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
// (scripts/checks/harness.ts enforces this split mechanically).
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createReporter } from './lib/report.ts';
import type { CheckModule } from './lib/report.ts';
import { root, walk } from './lib/files.ts';
import { parseModule, renderIndex } from './lib/guards.ts';

import components from './checks/components.ts';
import shellDiscipline from './checks/shell-discipline.ts';
import labelProtocol from './checks/label-protocol.ts';
import standards from './checks/standards.ts';
import hooks from './checks/hooks.ts';
import hooksClassifier from './checks/hooks-classifier.ts';
import hooksCockpitRules from './checks/hooks-cockpit-rules.ts';
import hooksGateRule from './checks/hooks-gate-rule.ts';
import gateClaim from './checks/gate-claim.ts';
import allowlist from './checks/allowlist.ts';
import config from './checks/config.ts';
import install from './checks/install.ts';
import release from './checks/release.ts';
import labels from './checks/labels.ts';
import artifacts from './checks/artifacts.ts';
import docs from './checks/docs.ts';
import layout from './checks/layout.ts';
import evals from './checks/evals.ts';
import cockpit from './checks/cockpit.ts';
import cockpitTick from './checks/cockpit-tick.ts';
import worktrees from './checks/worktrees.ts';
import preflight from './checks/preflight.ts';
import budget from './checks/budget.ts';
import reviewEvidence from './checks/review-evidence.ts';
import harness from './checks/harness.ts';
import guards from './checks/guards.ts';
import companions from './checks/companions.ts';
import desktopPlatform from './checks/desktop-platform.ts';
import desktopRegistry from './checks/desktop-registry.ts';
import desktopGithub from './checks/desktop-github.ts';
import desktopSessions from './checks/desktop-sessions.ts';
import desktopRenderer from './checks/desktop-renderer.ts';
import desktopLocal from './checks/desktop-local.ts';
import desktopReclaimer from './checks/desktop-reclaimer.ts';
import desktopState from './checks/desktop-state.ts';
import desktopWrites from './checks/desktop-writes.ts';
import desktopBoard from './checks/desktop-board.ts';
import desktopClaim from './checks/desktop-claim.ts';
import desktopActions from './checks/desktop-actions.ts';
import desktopGate from './checks/desktop-gate.ts';
import desktopSearch from './checks/desktop-search.ts';
import desktopTick from './checks/desktop-tick.ts';
import desktopRuntime from './checks/desktop-runtime.ts';
import fileSize from './checks/file-size.ts';
import tick from './checks/tick.ts';
import tickEvents from './checks/tick-events.ts';
import analyze from './checks/analyze.ts';
import forensics from './checks/forensics.ts';

// `--guards` is a second mode, not a check: it reads every topic module's own
// guard(#N) markers (scripts/checks/*.ts → docs/TESTING.md's replacement for
// the single hub-file table, #217) and renders the index on demand — no
// fail/note/ok, no reporter, so scripts/checks/harness.ts's split assertion
// still holds unchanged. `--issue <n>` narrows to entries citing that issue;
// a narrowed run that matches nothing is a failing answer, never a silent
// pass (docs/ENGINEERING.md §4).
const argv = process.argv.slice(2);
if (argv.includes('--guards')) {
  const files = walk(join(root, 'scripts/checks'))
    .filter((f) => f.endsWith('.ts'))
    .sort();
  const entries = files.flatMap((f) => parseModule(readFileSync(f, 'utf8'), basename(f, '.ts')));

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

  const modules: CheckModule[] = [
    components,
    shellDiscipline,
    labelProtocol,
    standards,
    hooks,
    hooksClassifier,
    hooksCockpitRules,
    hooksGateRule,
    gateClaim,
    allowlist,
    config,
    install,
    release,
    labels,
    artifacts,
    docs,
    layout,
    evals,
    cockpit,
    cockpitTick,
    worktrees,
    preflight,
    budget,
    reviewEvidence,
    harness,
    guards,
    companions,
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
    desktopGate,
    desktopSearch,
    desktopTick,
    desktopRuntime,
    fileSize,
    tick,
    tickEvents,
    analyze,
    forensics,
  ];

  for (const module of modules) {
    await module(reporter);
  }

  reporter.report();
}
