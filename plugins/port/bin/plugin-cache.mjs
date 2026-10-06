#!/usr/bin/env node
// Plugin cache cleanup — removes only what a dead project pins.
// Usage: report|apply [--json] [--home <dir>] [--plugins <key>,...]
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const USAGE = 'usage: node plugin-cache.mjs <report|apply> [--home <dir>] [--plugins <key>,...] [--json]';
const DEFAULT_PLUGINS = ['port@port'];

const die = (msg) => {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
};

// --- Pure classifier ---------------------------------------------------------

function keyOf(record) {
  return `${record.marketplaceName}@${record.pluginName}`;
}

/** A record is dead when its projectPath no longer exists; a cache directory
 *  is unreferenced when no live record's installPath resolves to it. */
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

// Case-insensitive on win32 only, mirroring bin/worktrees.mjs's pathKey.
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

/** Every cache/<marketplace>/<plugin>/<version>/ directory on disk. */
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

/** Refuses a path outside <home>/plugins/cache/<marketplace> for a
 *  marketplace in scope — nothing in the running CLI can trip this. */
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
