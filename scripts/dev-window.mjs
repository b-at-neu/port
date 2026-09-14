#!/usr/bin/env node
// Restores the integration branch's prerelease "dev window" after a release
// bump merges (#224). Invoked as `release.postPublishHook` from
// `/port:release` Phase B, and safe to run by hand.
//
// Why this exists: the plugin's on-disk cache directory is keyed by
// marketplace + plugin + version. A release bump strips the integration
// branch's prerelease suffix as part of the existing bump commit, so between
// that merge and this script's own pull request landing, the integration
// branch briefly carries a version string a released consumer could also be
// pinned to — reinstalling either resolves to the same cache directory and
// overwrites the other. This script reopens the corridor by bumping the
// integration branch to the next patch version with a prerelease suffix,
// which no released install can ever occupy.
//
// Decision logic (parseVersion, nextDevWindow, decide) is pure and exported,
// so the layer 1 check in scripts/checks/release.mjs can assert every case
// without a git subprocess (docs/ENGINEERING.md §1's guard-rules.mjs split).
// The I/O — reading config, talking to git and gh — lives in this same
// file's thin CLI wrapper below.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The suffix is this project's own documented convention, not recovered from
// git history — a single constant here is the same behaviour as archaeology
// across the previous manifest commit, with one fewer unreadable-history
// failure mode now that this script is port-only.
export const DEV_SUFFIX = 'dev';

/** Parses `X.Y.Z` with an optional `-<prerelease>` suffix. Returns
 *  `{major, minor, patch, suffix}` (`suffix` null when absent), or `null` for
 *  anything malformed — never a guessed default. */
export function parseVersion(raw) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), suffix: m[4] ?? null };
}

/** The next-patch dev-window version for a clean (non-prerelease) production
 *  version, e.g. `nextDevWindow('0.2.0')` → `'0.2.1-dev'`, never
 *  `'0.3.0-dev'` — the placeholder claims as little as possible about the
 *  size of the pending release. Throws on malformed or already-suffixed
 *  input rather than defaulting. */
export function nextDevWindow(productionVersion, suffix = DEV_SUFFIX) {
  const v = parseVersion(productionVersion);
  if (!v) throw new Error(`nextDevWindow: '${productionVersion}' is not a well-formed semver`);
  if (v.suffix) throw new Error(`nextDevWindow: '${productionVersion}' already carries a prerelease suffix`);
  return `${v.major}.${v.minor}.${v.patch + 1}-${suffix}`;
}

/** The pure decision: given the integration branch's current version, the
 *  next dev-window version (already computed from production's version by
 *  the caller), and whether that window's branch already exists on origin —
 *  which of the three outcomes applies. Never touches git or gh itself. */
export function decide({ integrationVersion, next, devWindowBranchExists }) {
  const integration = parseVersion(integrationVersion);
  if (!integration) throw new Error(`decide: integration version '${integrationVersion}' is not well-formed semver`);
  const branch = `devwindow/v${next}`;
  if (integration.suffix) return { action: 'nothing-to-do', version: integrationVersion };
  if (devWindowBranchExists) return { action: 'pr-exists', version: next, branch };
  return { action: 'open', version: next, branch };
}

// --- I/O wrapper -------------------------------------------------------

function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

function loadConfig(root) {
  const cfg = JSON.parse(readFileSync(join(root, '.claude/port.config.json'), 'utf8'));
  const repo = cfg.repo;
  const integration = cfg.branches?.integration ?? 'dev';
  const production = cfg.branches?.production ?? 'main';
  const versionFile = cfg.release?.versionFiles?.[0];
  if (!repo) throw new Error('.claude/port.config.json: repo is required');
  if (!versionFile) throw new Error('.claude/port.config.json: release.versionFiles must name at least one file');
  return { repo, integration, production, versionFile };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function readVersionAt(ref, path) {
  let text;
  try {
    text = git(['show', `${ref}:${path}`]);
  } catch (e) {
    throw new Error(`FAIL: could not read '${path}' at '${ref}': ${e.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (e) {
    throw new Error(`FAIL: '${path}' at '${ref}' is not valid JSON: ${e.message}`);
  }
  if (typeof manifest.version !== 'string') {
    throw new Error(`FAIL: '${path}' at '${ref}' has no string 'version' field`);
  }
  return manifest.version;
}

function remoteBranchExists(branch) {
  return git(['ls-remote', '--heads', 'origin', branch]).length > 0;
}

function findOpenPrUrl(repo, branch) {
  const out = execFileSync(
    'gh',
    ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url'],
    { encoding: 'utf8' },
  ).trim();
  return out.length > 0 ? out : null;
}

/** Part 1's detached-checkout shape, reused exactly: no local branch
 *  survives, so a retry after a failed push cannot collide with a stale
 *  local one — the remote branch stays the single source of truth for
 *  in-flight state. Restores the entry ref on every path, failure included,
 *  and asserts the restoration rather than assuming it. */
function openDevWindow({ root, cfg, next, branch }) {
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
      `#0 open dev window for v${next}\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n`,
    );
    git(['add', cfg.versionFile]);
    git(['commit', '-F', commitMsgPath]);
    // devwindow/v<next> is deliberately not bump/v<next> — release/SKILL.md
    // §0.5 case 1 matches `bump/v*` and would adopt this branch as an
    // in-flight release.
    git(['push', 'origin', `HEAD:refs/heads/${branch}`]);
  } catch (e) {
    try {
      restore();
    } catch (restoreErr) {
      // Never let a failed restore erase the original failure — that would
      // hide why the checkout/commit/push actually broke behind an unrelated
      // restore-mismatch message.
      throw new Error(`FAIL: ${e.message}\n(restore() also failed: ${restoreErr.message})`, { cause: e });
    }
    throw e;
  }

  restore();

  const bodyPath = join(root, '.temp/devwindow-pr.md');
  writeFileSync(
    bodyPath,
    `Opens the dev window at v${next} so the integration branch never carries a version a released consumer can be pinned to (#224).\n`,
  );
  const url = execFileSync(
    'gh',
    ['pr', 'create', '--repo', cfg.repo, '--base', cfg.integration, '--head', branch, '--title', `#0 open dev window for v${next}`, '--body-file', bodyPath],
    { encoding: 'utf8' },
  ).trim();
  console.log(url);
  console.log('Merge this before anything else — until it lands, dev carries a version a released consumer can be pinned to.');
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const root = repoRoot();
  const cfg = loadConfig(root);

  git(['fetch', 'origin']);

  const productionVersion = readVersionAt(`origin/${cfg.production}`, cfg.versionFile);
  const integrationVersion = readVersionAt(`origin/${cfg.integration}`, cfg.versionFile);
  const next = nextDevWindow(productionVersion);
  const branch = `devwindow/v${next}`;
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
