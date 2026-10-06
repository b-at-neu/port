#!/usr/bin/env node
// Reopens the prerelease "dev window" after a release bump, so a released
// consumer and the next-in-progress version never share a plugin cache key.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { message } from './lib/errors.ts';

// Documented convention, not recovered from git history.
export const DEV_SUFFIX = 'dev';

/** Parses `X.Y.Z` with an optional `-<prerelease>` suffix. `null` for anything malformed —
 *  never a guessed default. */
export function parseVersion(raw: unknown): { major: number; minor: number; patch: number; suffix: string | null } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), suffix: m[4] ?? null };
}

/** The next-patch dev-window version for a clean production version, e.g.
 *  `nextDevWindow('0.2.0')` → `'0.2.1-dev'`. Throws on malformed or already-suffixed input. */
export function nextDevWindow(productionVersion: string, suffix = DEV_SUFFIX): string {
  const v = parseVersion(productionVersion);
  if (!v) throw new Error(`nextDevWindow: '${productionVersion}' is not a well-formed semver`);
  if (v.suffix) throw new Error(`nextDevWindow: '${productionVersion}' already carries a prerelease suffix`);
  return `${v.major}.${v.minor}.${v.patch + 1}-${suffix}`;
}

/** The one constructor for a dev-window branch name, shared with
 *  `scripts/release-corridor.ts` so the shape never drifts between them. */
export function devWindowBranch(next: string): string {
  return `devwindow/v${next}`;
}

/** No ticket-number prefix — matches the release skill's bump subject. */
export function devWindowSubject(next: string): string {
  return `open dev window for v${next}`;
}

/** The pure decision over which of the three outcomes applies. Never touches git or gh itself. */
export function decide({ integrationVersion, next, devWindowBranchExists }: { integrationVersion: string; next: string; devWindowBranchExists: boolean }): any {
  const integration = parseVersion(integrationVersion);
  if (!integration) throw new Error(`decide: integration version '${integrationVersion}' is not well-formed semver`);
  const branch = devWindowBranch(next);
  if (integration.suffix) return { action: 'nothing-to-do', version: integrationVersion };
  if (devWindowBranchExists) return { action: 'pr-exists', version: next, branch };
  return { action: 'open', version: next, branch };
}

// --- I/O wrapper -------------------------------------------------------

function repoRoot(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

function loadConfig(root: string): any {
  const cfg = JSON.parse(readFileSync(join(root, '.claude/port.config.json'), 'utf8'));
  const repo = cfg.repo;
  const integration = cfg.branches?.integration ?? 'dev';
  const production = cfg.branches?.production ?? 'main';
  const versionFile = cfg.release?.versionFiles?.[0];
  if (!repo) throw new Error('.claude/port.config.json: repo is required');
  if (!versionFile) throw new Error('.claude/port.config.json: release.versionFiles must name at least one file');
  return { repo, integration, production, versionFile };
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function readVersionAt(ref: string, path: string): string {
  let text: string;
  try {
    text = git(['show', `${ref}:${path}`]);
  } catch (e) {
    throw new Error(`FAIL: could not read '${path}' at '${ref}': ${message(e)}`);
  }
  let manifest: any;
  try {
    manifest = JSON.parse(text);
  } catch (e) {
    throw new Error(`FAIL: '${path}' at '${ref}' is not valid JSON: ${message(e)}`);
  }
  if (typeof manifest.version !== 'string') {
    throw new Error(`FAIL: '${path}' at '${ref}' has no string 'version' field`);
  }
  return manifest.version;
}

function remoteBranchExists(branch: string): boolean {
  return git(['ls-remote', '--heads', 'origin', branch]).length > 0;
}

function findOpenPrUrl(repo: string, branch: string): string | null {
  const out = execFileSync(
    'gh',
    ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url'],
    { encoding: 'utf8' },
  ).trim();
  return out.length > 0 ? out : null;
}

/** A detached checkout: no local branch survives, so a retry after a failed push cannot
 *  collide with a stale one. Restores the entry ref on every path, including failure. */
function openDevWindow({ root, cfg, next, branch }: { root: string; cfg: any; next: string; branch: string }): void {
  const entryRefRaw = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const entryRef = entryRefRaw === 'HEAD' ? git(['rev-parse', 'HEAD']) : entryRefRaw;

  const restore = () => {
    git(['checkout', entryRef]);
    const back = git(['rev-parse', '--abbrev-ref', 'HEAD']) === 'HEAD' ? git(['rev-parse', 'HEAD']) : git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (back !== entryRef) {
      throw new Error(`FAIL: restore mismatch — expected to be back on '${entryRef}', found '${back}'. Return to '${entryRef}' by hand.`);
    }
  };

  try {
    git(['checkout', '--detach', `origin/${cfg.integration}`]);

    const path = join(root, cfg.versionFile);
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.version = next;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);

    const commitMsgPath = join(root, '.temp/commit-msg.txt');
    writeFileSync(
      commitMsgPath,
      `${devWindowSubject(next)}\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n`,
    );
    git(['add', cfg.versionFile]);
    git(['commit', '-F', commitMsgPath]);
    // Deliberately not bump/v<next> — release/SKILL.md's case 1 would adopt that as an in-flight release.
    git(['push', 'origin', `HEAD:refs/heads/${branch}`]);
  } catch (e) {
    try {
      restore();
    } catch (restoreErr) {
      // Never let a failed restore erase the original failure behind an unrelated restore-mismatch message.
      throw new Error(`FAIL: ${message(e)}\n(restore() also failed: ${message(restoreErr)})`, { cause: e });
    }
    throw e;
  }

  restore();

  const bodyPath = join(root, '.temp/devwindow-pr.md');
  writeFileSync(
    bodyPath,
    `Opens the dev window at v${next} so the integration branch never carries a version a released consumer can be pinned to.\n`,
  );
  const url = execFileSync(
    'gh',
    ['pr', 'create', '--repo', cfg.repo, '--base', cfg.integration, '--head', branch, '--title', devWindowSubject(next), '--body-file', bodyPath],
    { encoding: 'utf8' },
  ).trim();
  console.log(url);
  console.log('Merge this before anything else — until it lands, dev carries a version a released consumer can be pinned to.');
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  const root = repoRoot();
  const cfg = loadConfig(root);

  git(['fetch', 'origin']);

  const productionVersion = readVersionAt(`origin/${cfg.production}`, cfg.versionFile);
  const integrationVersion = readVersionAt(`origin/${cfg.integration}`, cfg.versionFile);
  const next = nextDevWindow(productionVersion);
  const branch = devWindowBranch(next);
  const devWindowBranchExists = remoteBranchExists(branch);

  const result = decide({ integrationVersion, next, devWindowBranchExists });

  if (result.action === 'nothing-to-do') {
    console.log(`nothing to do — ${cfg.integration} is already at ${result.version}`);
    return;
  }

  if (result.action === 'pr-exists') {
    const url = findOpenPrUrl(cfg.repo, result.branch);
    console.log(url ?? `${result.branch} already exists on origin but no open pull request was found for it — open one manually against ${cfg.integration}`);
    return;
  }

  if (dryRun) {
    console.log(`plan: open ${result.branch} at ${result.version} against ${cfg.integration} (dry run — nothing written or pushed)`);
    return;
  }

  openDevWindow({ root, cfg, next: result.version, branch: result.branch });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
