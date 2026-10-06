#!/usr/bin/env node
// Plugin cache cleanup — removes only what a dead project pins (#344).
//
// Claude Code's documented sweep removes an `.orphaned_at`-marked cache
// directory 14 days after an update. It only fires when a version bump is
// recognized as an update to the same tracked install, so it never marks a
// directory a `local`/`project`-scope record still points at — and deleting
// that record's own project (a worktree, a removed clone, a moved repo)
// never removes the record itself, since `claude plugin uninstall --scope
// local` cannot run from a directory that no longer exists. The record pins
// its version directory for good. Not specific to any one repository's dev
// loop: any adopter who installs port per-project and later deletes or moves
// that project hits this, in every repo, on every machine they use.
//
//   report [--json] [--home <dir>] [--plugins <key>,...]
//     Classify every installed_plugins.json record and cache directory,
//     remove nothing.
//
//   apply [--home <dir>] [--plugins <key>,...]
//     Back up installed_plugins.json, remove every dead record, then delete
//     every cache directory no live record's installPath resolves to.
//
// Self-contained — no relative imports, so an adopting repository can run
// this file alone, on any machine with port installed, through the shipped
// `/port:plugin-cache-clean` skill. Every child process is invoked with an
// explicit argv array via node:child_process, never a shell string.
//
// Scope is `port@port` only by default (`--plugins` widens it, comma-
// separated `<marketplace>@<plugin>` keys — a repository running its own
// differently-named dev-loop marketplace passes its own key here) — a
// shipped tool deleting another vendor's cache is out of bounds.
// Deletion is fenced to `<home>/plugins/cache/<marketplace>` for exactly the
// marketplaces in scope; a resolved path outside that fence is never
// deleted, whatever classify() says.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const USAGE = 'usage: node plugin-cache.mjs <report|apply> [--home <dir>] [--plugins <key>,...] [--json]';
const DEFAULT_PLUGINS = ['port@port'];

/** One clear line, no stack trace. */
const die = (msg) => {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
};

// --- Pure classifier (exported for this repository's own layer 1 checks) ----

/** Resolves a plugin key (`<marketplace>@<plugin>`) from an install record's
 *  own fields — the record itself never carries one. */
function keyOf(record) {
  return `${record.marketplaceName}@${record.pluginName}`;
}

/** Classifies the parsed `installed_plugins.json` against the cache
 *  directories actually on disk, for the given `plugins` key filter alone —
 *  a non-matching record or directory is simply invisible to this call, as
 *  if it did not exist.
 *
 *  `installed` is the parsed JSON (an object keyed by install identity, each
 *  value an array of records, or a single record — Claude Code's own shape
 *  is not guaranteed array-vs-object per key, so both are normalized here).
 *  `exists(projectPath)` is an injected predicate so this stays pure.
 *  `cacheDirs` is `{ marketplace, plugin, version, path }[]`.
 *
 *  A record is **dead** when it carries a `projectPath` and `exists(…)` is
 *  false — a `user`-scope record (no `projectPath`) is never dead, since
 *  nothing about it can go stale this way. A cache directory is
 *  **unreferenced** when no *live* record's `installPath` resolves to it —
 *  compared case-insensitively on win32, matching `pathKey` in
 *  `bin/worktrees.mjs`. Returns `{ deadRecords, liveRecords, unreferenced }`;
 *  `deadRecords`/`liveRecords` entries carry `{ key, index, scope,
 *  projectPath, installPath }` so a caller can both report and remove them
 *  without re-deriving anything. */
export function classify({ installed, exists, cacheDirs, plugins = DEFAULT_PLUGINS }) {
  const wanted = new Set(plugins);
  const deadRecords = [];
  const liveRecords = [];

  for (const [key, value] of Object.entries(installed ?? {})) {
    const records = Array.isArray(value) ? value : [value];
    records.forEach((record, index) => {
      if (!record || typeof record !== 'object') return;
      if (!wanted.has(keyOf(record))) return;
      const entry = {
        key,
        index,
        scope: record.scope ?? null,
        projectPath: record.projectPath ?? null,
        installPath: record.installPath ?? null,
      };
      const dead = !!entry.projectPath && !exists(entry.projectPath);
      (dead ? deadRecords : liveRecords).push(entry);
    });
  }

  const liveInstallKeys = new Set(liveRecords.filter((r) => r.installPath).map((r) => pathKeyOf(r.installPath)));
  const unreferenced = cacheDirs
    .filter((d) => wanted.has(`${d.marketplace}@${d.plugin}`))
    .filter((d) => !liveInstallKeys.has(pathKeyOf(d.path)))
    .map((d) => d.path);

  return { deadRecords, liveRecords, unreferenced };
}

/** Case-insensitive on win32 only, mirroring `bin/worktrees.mjs`'s own
 *  `pathKey` — this file does not resolve symlinks or short-name aliases,
 *  since both sides of every comparison here come from the same JSON or the
 *  same `readdirSync` walk, never a filesystem handle. */
function pathKeyOf(p) {
  const r = resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

// --- I/O ----------------------------------------------------------------------

function resolveHome(opts) {
  if (opts.home) return opts.home;
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  return join(homedir(), '.claude');
}

function readInstalled(home) {
  const path = join(home, 'plugins', 'installed_plugins.json');
  if (!existsSync(path)) return { path, installed: null };
  let installed;
  try {
    installed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    die(`${path} did not parse as JSON: ${e.message}`);
  }
  return { path, installed };
}

/** Every `<home>/plugins/cache/<marketplace>/<plugin>/<version>/` directory,
 *  for marketplaces actually present on disk — never assumes a marketplace
 *  name from `plugins` alone, since a scope filter with nothing installed
 *  under it must find zero directories, not error. */
function findCacheDirs(home) {
  const cacheRoot = join(home, 'plugins', 'cache');
  if (!existsSync(cacheRoot)) return [];
  const dirs = [];
  for (const marketplace of listDirs(cacheRoot)) {
    const marketplaceDir = join(cacheRoot, marketplace);
    for (const plugin of listDirs(marketplaceDir)) {
      const pluginDir = join(marketplaceDir, plugin);
      for (const version of listDirs(pluginDir)) {
        dirs.push({ marketplace, plugin, version, path: join(pluginDir, version) });
      }
    }
  }
  return dirs;
}

function listDirs(dir) {
  try {
    return readdirSync(dir).filter((f) => {
      try {
        return statSync(join(dir, f)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** Refuses to delete anything outside `<home>/plugins/cache/<marketplace>`
 *  for a marketplace actually in `plugins` scope — the one guard standing
 *  between a malformed or hand-edited `installPath` and an arbitrary delete.
 *  Exit 2, nothing touched, the moment one path fails this fence. Every path
 *  `apply` ever deletes comes from `findCacheDirs`, which only ever walks
 *  `<home>/plugins/cache/<marketplace>/` in the first place — so in the
 *  running CLI this can never actually fail. It exists, and is exported and
 *  unit-tested directly, as the second independent check: if `classify`'s
 *  caller is ever changed to source a deletion candidate from anywhere but
 *  `findCacheDirs` (an `installPath` taken on faith, say), this is what
 *  still stands between that and an arbitrary delete. */
export function assertFenced(path, home, plugins) {
  const marketplaces = new Set(plugins.map((p) => p.split('@')[0]));
  const key = pathKeyOf(path);
  for (const marketplace of marketplaces) {
    const fence = pathKeyOf(join(home, 'plugins', 'cache', marketplace)) + sep;
    if (key.startsWith(fence) || key === pathKeyOf(join(home, 'plugins', 'cache', marketplace))) return true;
  }
  return false;
}

function timestampForBackup() {
  return new Date().toISOString().replace(/:/g, '-');
}

// --- CLI ------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { home: null, plugins: DEFAULT_PLUGINS, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--home') opts.home = argv[++i];
    else if (a === '--plugins') opts.plugins = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--json') opts.json = true;
    else die(`unrecognized argument '${a}'. ${USAGE}`);
  }
  return opts;
}

function runReport(opts) {
  const home = resolveHome(opts);
  const { path, installed } = readInstalled(home);
  const cacheDirs = findCacheDirs(home);

  if (installed === null && cacheDirs.length === 0) {
    if (opts.json) console.log(JSON.stringify({ home, nothingToDo: true }, null, 2));
    else console.log(`nothing to do — ${path} does not exist and no cache directories were found under ${home}`);
    process.exit(0);
  }

  const result = classify({
    installed,
    exists: (p) => existsSync(p),
    cacheDirs,
    plugins: opts.plugins,
  });

  if (opts.json) {
    console.log(JSON.stringify({ home, ...result }, null, 2));
    return;
  }

  console.log(`Home: ${home}`);
  console.log('');
  console.log(`Stale install records (${result.deadRecords.length}):`);
  for (const r of result.deadRecords) {
    console.log(`  ${r.key}[${r.index}]\t${r.scope}\t${r.projectPath}\t${r.installPath}`);
  }
  console.log('');
  console.log(`Unreferenced cache directories (${result.unreferenced.length}):`);
  for (const d of result.unreferenced) console.log(`  ${d}`);
  console.log('');
  console.log('Run `apply` to remove the stale records and unreferenced directories above.');
}

function runApply(opts) {
  const home = resolveHome(opts);
  const { path, installed } = readInstalled(home);
  const cacheDirs = findCacheDirs(home);

  if (installed === null && cacheDirs.length === 0) {
    console.log(`nothing to do — ${path} does not exist and no cache directories were found under ${home}`);
    process.exit(0);
  }

  const result = classify({
    installed,
    exists: (p) => existsSync(p),
    cacheDirs,
    plugins: opts.plugins,
  });

  for (const d of result.unreferenced) {
    if (!assertFenced(d, home, opts.plugins)) {
      die(`${d} resolves outside <home>/plugins/cache/<marketplace> for the plugins in scope — refusing to delete anything, nothing was touched`);
    }
  }

  let backupPath = null;
  if (installed !== null && result.deadRecords.length > 0) {
    backupPath = `${path}.bak-${timestampForBackup()}`;
    writeFileSync(backupPath, readFileSync(path, 'utf8'));

    const next = structuredClone(installed);
    const deadByKey = new Map();
    for (const r of result.deadRecords) {
      if (!deadByKey.has(r.key)) deadByKey.set(r.key, new Set());
      deadByKey.get(r.key).add(r.index);
    }
    for (const [key, indices] of deadByKey) {
      const value = next[key];
      const records = Array.isArray(value) ? value : [value];
      const kept = records.filter((_, i) => !indices.has(i));
      if (kept.length === 0) delete next[key];
      else next[key] = Array.isArray(value) ? kept : kept[0];
    }
    writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
  }

  let removedCount = 0;
  for (const d of result.unreferenced) {
    rmSync(d, { recursive: true, force: true });
    removedCount++;
  }

  console.log(`Removed ${result.deadRecords.length} stale record(s)${backupPath ? ` (backup: ${backupPath})` : ''}.`);
  console.log(`Removed ${removedCount} unreferenced cache director(ies).`);
  if (removedCount > 0 || result.deadRecords.length > 0) {
    console.log('Restart any running Claude Code session so it stops resolving the removed records or directories.');
  }
}

function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode !== 'report' && mode !== 'apply') die(`unrecognized mode. ${USAGE}`);
  const opts = parseArgs(rest);
  if (mode === 'report') runReport(opts);
  else runApply(opts);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
