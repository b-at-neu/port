#!/usr/bin/env node
// Layer 1 of the testing loop: deterministic checks over the plugin's files, no model calls.
// This file only wires: discovers every topic module under scripts/checks/, imports and awaits each, then reports.
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
