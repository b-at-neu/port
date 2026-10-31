#!/usr/bin/env node
// CLI entry: arg parse, the one `report` subcommand, text vs `--json`. Wiring only.
// An operator tool, never `commands.checks` — it shells out to `gh` and reads machine-local paths.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runReport, renderText, renderJson } from './port-forensics/report.ts';

function repoRoot(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
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

function die(message: string, exitCode = 1): void {
  process.stderr.write(`FAIL  forensics: ${message}\n`);
  process.exitCode = exitCode;
}

function cmdReport(flags: any): void {
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

function main(): void {
  const [subcommand, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (subcommand === 'report') return cmdReport(flags);
  return die(`unrecognized subcommand '${subcommand ?? ''}'. usage: node port-forensics.ts report [--session <id>] [--since <iso>] [--json] [--claude-home <path>]`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
