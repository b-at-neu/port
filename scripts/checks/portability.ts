// Allowlist portability ratchet, plus the CI matrix guard moved here from
// config.ts (#116). Both rails exist for the same reason: a Windows-broken
// allowlist entry, or a quietly dropped runner, ships to every adopter with
// nothing to object — this module is the mechanical objection.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { root, readJson } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';
import { message } from '../lib/errors.ts';

const CONFIG_REL = 'scripts/checks/portability.config.json';

/** The leading whitespace-delimited token of a `Bash(...)` allowlist entry,
 *  or `null` for anything that is not `Bash(...)` (e.g. `Edit(**)`, `Skill`)
 *  or whose leading token is an unsubstituted `{{placeholder}}` — never real
 *  for this repository itself, only for a template an adopter fills in.
 *  Pure, so the block below can self-test it before trusting it against the
 *  repository's real config files. */
export function leadingToken(entry: string): string | null {
  const m = /^Bash\(([^)]*)\)$/.exec(entry);
  if (!m) return null;
  const token = m[1].trim().split(/\s+/)[0];
  if (!token || token.startsWith('{{')) return null;
  return token;
}

export interface AllowlistClassification {
  /** Entries whose leading token is classified non-portable and not on this
   *  file's pending list. */
  violations: { entry: string; token: string }[];
  /** Pending tokens for this file that no entry actually carries any more. */
  stale: string[];
}

/** Pure classification, no I/O — `entries` is one file's `allow`-shaped
 *  array, `nonPortable` the shared classification, `pendingTokens` the same
 *  file's own pending list from portability.config.json. */
export function classifyAllowlist(
  entries: readonly string[],
  nonPortable: readonly string[],
  pendingTokens: readonly string[],
): AllowlistClassification {
  const nonPortableSet = new Set(nonPortable);
  const pendingSet = new Set(pendingTokens);
  const seen = new Set<string>();
  const violations: { entry: string; token: string }[] = [];
  for (const entry of entries) {
    const token = leadingToken(entry);
    if (token === null || !nonPortableSet.has(token)) continue;
    seen.add(token);
    if (!pendingSet.has(token)) violations.push({ entry, token });
  }
  const stale = pendingTokens.filter((t) => !seen.has(t));
  return { violations, stale };
}

/** Every job block's own lines, from its `  <job>:` line up to (not
 *  including) the next two-space-indented `key:` line — or `null` if the job
 *  is not found. Per-job, never a whole-file substring search: #73's own
 *  guard searched the entire workflow text for each runner label, so
 *  dropping `windows-latest` from one matrixed job while another still named
 *  it anywhere in the file passed regardless of which job lost it. */
export function extractJobBlock(lines: readonly string[], job: string): string[] | null {
  const startIdx = lines.findIndex((l) => l === `  ${job}:`);
  if (startIdx === -1) return null;
  const block = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^  [A-Za-z0-9_-]+:/.test(lines[i])) break;
    block.push(lines[i]);
  }
  return block;
}

const MATRIXED_JOBS = ['run-static-checks', 'run-app-checks'];
const RUNNER_LABELS = ['ubuntu-latest', 'macos-latest', 'windows-latest'];

export default async function ({ expect, fail, note, ok }: Reporter) {
  // --- Self-test first ---------------------------------------------------
  // guard(#116): a check that cannot be made to fail is not a check
  // (docs/ENGINEERING.md §7) — assert leadingToken/classifyAllowlist against
  // fixed synthetic inputs before trusting either against real files.
  {
    expect(!(leadingToken('Bash(grep *)') !== 'grep'), 'portability-selftest', "leadingToken('Bash(grep *)') did not return 'grep'");
    expect(!(leadingToken('Bash(node scripts/checks.ts *)') !== 'node'), 'portability-selftest', "leadingToken('Bash(node scripts/checks.ts *)') did not return 'node'");
    expect(!(leadingToken('Bash({{packageManager}} *)') !== null), 'portability-selftest', "leadingToken('Bash({{packageManager}} *)') must return null — an unsubstituted placeholder is never real for this repository");
    expect(!(leadingToken('Bash(mkdir -p *)') !== 'mkdir'), 'portability-selftest', "leadingToken('Bash(mkdir -p *)') did not return 'mkdir'");
    expect(!(leadingToken('Edit(**)') !== null), 'portability-selftest', "leadingToken('Edit(**)') must return null — it is not a Bash(...) entry");

    const oneViolation = classifyAllowlist(['Bash(grep *)'], ['grep'], []);
    expect(!(oneViolation.violations.length !== 1 || oneViolation.violations[0].token !== 'grep'), 'portability-selftest', "classifyAllowlist(['Bash(grep *)'], ['grep'], []) must report exactly one 'grep' violation");

    const clean = classifyAllowlist(['Bash(node scripts/checks.ts *)', 'Bash({{packageManager}} *)'], ['grep'], []);
    expect(!(clean.violations.length !== 0 || clean.stale.length !== 0), 'portability-selftest', 'classifyAllowlist over non-portable-free entries must report no violations and no stale tokens');

    const staleCase = classifyAllowlist([], ['mkdir'], ['mkdir']);
    expect(!(staleCase.stale.length !== 1 || staleCase.stale[0] !== 'mkdir'), 'portability-selftest', "a pending token absent from the entries must be reported stale");
  }

  // --- Self-test the job-block extractor ----------------------------------
  // guard(#116): the exact regression #73's whole-file search could not
  // detect — a synthetic workflow where only one of two matrixed jobs still
  // names every runner label.
  {
    const synthetic = [
      'jobs:',
      '  run-static-checks:',
      '    strategy:',
      '      matrix:',
      '        os: [ubuntu-latest, macos-latest]',
      '    runs-on: ${{ matrix.os }}',
      '  run-app-checks:',
      '    strategy:',
      '      matrix:',
      '        os: [ubuntu-latest, macos-latest, windows-latest]',
      '    runs-on: ${{ matrix.os }}',
      '  run-other-job:',
      '    runs-on: ubuntu-latest',
    ];
    const staticBlock = extractJobBlock(synthetic, 'run-static-checks');
    const appBlock = extractJobBlock(synthetic, 'run-app-checks');
    const missingBlock = extractJobBlock(synthetic, 'run-missing-job');
    if (!staticBlock || staticBlock.join('\n').includes('windows-latest')) {
      fail('portability-selftest', 'extractJobBlock: expected the synthetic run-static-checks block to lack windows-latest');
    } else if (!appBlock || !appBlock.join('\n').includes('windows-latest')) {
      fail('portability-selftest', 'extractJobBlock: expected the synthetic run-app-checks block to include windows-latest');
    } else expect(!(missingBlock !== null), 'portability-selftest', 'extractJobBlock: a job absent from the text must return null');
  }

  // --- Validate the config's own shape ------------------------------------
  // guard(#116): this repository requires the ratchet, so a missing or
  // malformed config fails rather than silently skipping — there is no
  // opt-out note the way file-size.ts's null limit provides, because a
  // Windows-broken allowlist entry is exactly the class of defect layer 1
  // exists to catch.
  const configPath = join(root, CONFIG_REL);
  if (!existsSync(configPath)) {
    fail('portability', `${CONFIG_REL} does not exist — the allowlist portability ratchet is required, not optional`);
    return;
  }
  let config: any;
  try {
    config = readJson(CONFIG_REL);
  } catch (e) {
    fail('portability', `${CONFIG_REL} is not valid JSON: ${message(e)}`);
    return;
  }
  ok();

  const nonPortable: string[] = Array.isArray(config.nonPortable) ? config.nonPortable : [];
  expect(!(!Array.isArray(config.nonPortable) || nonPortable.length === 0), 'portability', `${CONFIG_REL}: 'nonPortable' must be a non-empty array of command names`);
  const nonPortableSet = new Set(nonPortable);

  const pendingEntries: { file: string; commands: string[]; issue: number }[] = [];
  for (const entry of Array.isArray(config.pending) ? config.pending : []) {
    if (!entry || typeof entry.file !== 'string' || entry.file.length === 0) {
      fail('portability', `${CONFIG_REL}: a pending entry is missing a 'file' string`);
      continue;
    }
    if (!Array.isArray(entry.commands)) {
      fail('portability', `${CONFIG_REL}: pending entry for '${entry.file}' has a non-array 'commands'`);
      continue;
    }
    if (!Number.isInteger(entry.issue) || entry.issue <= 0) {
      fail('portability', `${CONFIG_REL}: pending entry for '${entry.file}' names no positive follow-up 'issue'`);
      continue;
    }
    let entryOk = true;
    for (const cmd of entry.commands) {
      if (typeof cmd !== 'string' || !nonPortableSet.has(cmd)) {
        fail('portability', `${CONFIG_REL}: pending entry for '${entry.file}' lists '${cmd}', which is not in 'nonPortable'`);
        entryOk = false;
      }
    }
    if (entryOk) ok();
    pendingEntries.push({ file: entry.file, commands: entry.commands, issue: entry.issue });
  }

  // --- Apply the ratchet ----------------------------------------------------
  // guard(#116): a non-portable command (missing on a plain Windows shell —
  // Claude Code's Bash tool there runs through Git Bash, so the exact
  // portability boundary is issue 114's audit question, not this check's)
  // joining an allowlist with nothing to object. Every scanned file is required —
  // a source that silently disappears is exactly the kind of absence this
  // check exists to catch, so a missing file fails rather than being
  // skipped.
  const sources: { file: string; extract: (cfg: any) => string[] }[] = [
    { file: 'plugins/port/templates/permissions.base.json', extract: (cfg) => cfg.allow ?? [] },
    { file: '.claude/settings.json', extract: (cfg) => cfg.permissions?.allow ?? [] },
    { file: '.claude/port.config.json', extract: (cfg) => cfg.extraAllow ?? [] },
    { file: 'plugins/port/templates/port.config.json', extract: (cfg) => cfg.extraAllow ?? [] },
  ];
  for (const { file, extract } of sources) {
    if (!existsSync(join(root, file))) {
      fail('portability', `${file} does not exist — it is one of the sources this check must scan`);
      continue;
    }
    let cfg: any;
    try {
      cfg = readJson(file);
    } catch (e) {
      fail('portability', `${file} is not valid JSON: ${message(e)}`);
      continue;
    }
    const entries: string[] = extract(cfg);
    const pendingTokens = pendingEntries.find((p) => p.file === file)?.commands ?? [];
    const { violations, stale } = classifyAllowlist(entries, nonPortable, pendingTokens);
    for (const { entry, token } of violations) {
      fail(
        'portability',
        `${file} allowlists \`${entry}\`, whose \`${token}\` is classified non-portable — use Read/Grep/Glob, git/gh, or a Node script instead (#114)`,
      );
    }
    for (const token of stale) {
      fail(
        'portability',
        `\`${token}\` is no longer allowlisted in ${file} — remove it from ${CONFIG_REL}'s pending list so the ratchet tightens`,
      );
    }
    if (violations.length === 0 && stale.length === 0) ok();
  }

  // --- CI workflow names every platform, per job, not just anywhere -------
  // guard(#73, #116): #73's own check searched the whole workflow file for
  // each runner label, so removing 'windows-latest' from run-static-checks
  // alone still passed because run-app-checks still named it. Moved here
  // (from config.ts) and strengthened to check per job, matching this
  // module's own job-block extraction.
  {
    const rel = '.github/workflows/checks.yml';
    if (!existsSync(join(root, rel))) {
      fail('platform-matrix', `${rel} does not exist`);
    } else {
      const lines = readFileSync(join(root, rel), 'utf8').split(/\r?\n/);
      for (const job of MATRIXED_JOBS) {
        const block = extractJobBlock(lines, job);
        if (!block) {
          fail('platform-matrix', `${rel}: job block '${job}' not found — a renamed job must fail this check, not pass it vacuously`);
          continue;
        }
        const text = block.join('\n');
        for (const runnerLabel of RUNNER_LABELS) {
          expect(text.includes(runnerLabel), 'platform-matrix', `${rel}: job '${job}' never names the runner label '${runnerLabel}'`);
        }
        expect(text.includes('runs-on: ${{ matrix.os }}'), 'platform-matrix', `${rel}: job '${job}' does not run on 'runs-on: \${{ matrix.os }}'`);
      }
    }
  }

  note(`portability: ${sources.length} allowlist sources scanned against ${nonPortable.length} non-portable commands, ${pendingEntries.length} file(s) with a pending ratchet entry`);
}
