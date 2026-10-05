#!/usr/bin/env node
// Layer 1 of the testing loop: deterministic checks over the plugin's files.
//
// No model calls, no dependencies, and no plugin install required — a
// dispatched agent's worktree may not resolve the plugin, so every check here
// works from files alone.
//
// This file only wires: it discovers every topic module under
// scripts/checks/ from disk, imports and awaits each in turn against the
// shared reporter, then reports. Check logic itself lives in the topic
// modules — never here, so the file stays thin no matter how many regression
// guards the topics below accumulate (scripts/checks/harness.ts enforces
// this split mechanically).
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createReporter } from './lib/report.ts';
import type { CheckModule } from './lib/report.ts';
import { root, walk } from './lib/files.ts';

const reporter = createReporter();

const files = walk(join(root, 'scripts/checks'))
  .filter((f) => f.endsWith('.ts'))
  .sort();
for (const f of files) {
  const module: CheckModule = (await import(pathToFileURL(f).href)).default;
  await module(reporter);
}

reporter.report();
