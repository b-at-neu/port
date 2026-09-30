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
// this split mechanically). #255: this runner used to hold two hand-
// maintained parallel lists of the same modules (a static import block plus
// a `modules` array) — every new topic module meant editing both, making
// this file itself a hub. Discovery from disk replaces both with the one
// list that was already load-bearing: the directory itself.
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReporter } from './lib/report.ts';
import type { CheckModule } from './lib/report.ts';
import { root, walk } from './lib/files.ts';
import { parseModule, renderIndex, renderPins } from './lib/guards.ts';

// `--guards`/`--pins` are two further modes, not checks: each reads every
// topic module's own guard(#N)/pin markers (scripts/checks/*.ts →
// docs/TESTING.md's replacement for the single hub-file table, #217, and
// docs/ENGINEERING.md §2's replacement for its copy-pin table, #255) and
// renders the matching index on demand — no fail/note/ok, no reporter, so
// scripts/checks/harness.ts's split assertion still holds unchanged.
// `--issue <n>` narrows `--guards` to entries citing that issue; a narrowed
// run that matches nothing is a failing answer, never a silent pass
// (docs/ENGINEERING.md §4).
const argv = process.argv.slice(2);
if (argv.includes('--guards') || argv.includes('--pins')) {
  const files = walk(join(root, 'scripts/checks'))
    .filter((f) => f.endsWith('.ts'))
    .sort();
  const entries = files.flatMap((f) => parseModule(readFileSync(f, 'utf8'), basename(f, '.ts')));

  if (argv.includes('--pins')) {
    process.stdout.write(renderPins(entries.filter((e) => e.kind === 'pin')));
  } else {
    const guardEntries = entries.filter((e) => e.kind === 'guard');
    const issueFlagIdx = argv.indexOf('--issue');
    if (issueFlagIdx === -1) {
      process.stdout.write(renderIndex(guardEntries));
    } else {
      const issue = Number(argv[issueFlagIdx + 1]);
      const matches = guardEntries.filter((e) => e.issues?.includes(issue));
      if (matches.length === 0) {
        console.error(`No guard cites #${issue}.`);
        process.exitCode = 1;
      } else {
        process.stdout.write(renderIndex(matches));
      }
    }
  }
} else {
  const reporter = createReporter();

  const files = walk(join(root, 'scripts/checks'))
    .filter((f) => f.endsWith('.ts'))
    .sort();
  for (const f of files) {
    const module: CheckModule = (await import(pathToFileURL(f).href)).default;
    await module(reporter);
  }

  reporter.report();
}
