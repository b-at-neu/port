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
import { createReporter } from './lib/report.mjs';

import components from './checks/components.mjs';
import shellDiscipline from './checks/shell-discipline.mjs';
import hooks from './checks/hooks.mjs';
import config from './checks/config.mjs';
import install from './checks/install.mjs';
import labels from './checks/labels.mjs';
import artifacts from './checks/artifacts.mjs';
import docs from './checks/docs.mjs';
import evals from './checks/evals.mjs';
import cockpit from './checks/cockpit.mjs';
import reviewEvidence from './checks/review-evidence.mjs';
import harness from './checks/harness.mjs';
import desktopPlatform from './checks/desktop-platform.mjs';
import fileSize from './checks/file-size.mjs';

const reporter = createReporter();

for (const module of [
  components,
  shellDiscipline,
  hooks,
  config,
  install,
  labels,
  artifacts,
  docs,
  evals,
  cockpit,
  reviewEvidence,
  harness,
  desktopPlatform,
  fileSize,
]) {
  await module(reporter);
}

reporter.report();
