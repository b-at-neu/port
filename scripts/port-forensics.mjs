#!/usr/bin/env node
// The forensics engine's CLI entry (#123): arg parse, the one `report`
// subcommand, exit codes, text vs `--json`. Every decision is imported from
// scripts/lib/transcript.mjs and scripts/port-forensics/ — this file only
// wires, the same runner-plus-modules split scripts/port-tick.mjs already
// establishes (docs/ENGINEERING.md §1).
//
// An operator and cockpit-tick tool, never `commands.checks`
// (scripts/checks/evals.mjs pins the absence): it reads a machine-local path
// outside the repository and shells out to `gh`, so it is meaningless in CI
// and unavailable to a dispatched agent's own worktree.
//
//   report [--session <id>] [--since <iso>] [--json] [--claude-home <path>]
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runReport, renderText, renderJson } from './port-forensics/report.mjs';

function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      out.json = true;
      continue;
    }
    if (a.startsWith('--')) {
      out[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function die(message, exitCode = 1) {
  process.stderr.write(`FAIL  forensics: ${message}\n`);
  process.exitCode = exitCode;
}

function cmdReport(flags) {
  const result = runReport({
    session: flags.session,
    since: flags.since,
    claudeHome: flags['claude-home'],
    repoRoot: repoRoot(),
  });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(renderJson(result), null, 2)}\n`);
  } else {
    process.stdout.write(`${renderText(result)}\n`);
  }
  process.exitCode = result.exitCode;
}

function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (subcommand === 'report') return cmdReport(flags);
  return die(`unrecognized subcommand '${subcommand ?? ''}'. usage: node port-forensics.mjs report [--session <id>] [--since <iso>] [--json] [--claude-home <path>]`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
