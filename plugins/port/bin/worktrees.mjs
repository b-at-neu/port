#!/usr/bin/env node
// Worktree reclamation — one deterministic call whose stdout is the report. `report`
// classifies, `reclaim` also removes what is reclaimable, `purge --orphan` deletes one path.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname, basename, relative, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = "usage: node worktrees.mjs <report|reclaim> [--issue N] [--max K] [--protect <path>]... [--offline] [--json] [--unlock] [--force-dirty]\n       node worktrees.mjs purge --orphan <path>... [--json]";

/** One clear line, no stack trace. */
const die = (msg) => {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
};

// --- Process helpers --- Runs `cmd` with an explicit argv array, never a shell string.
/** Never throws on a non-zero exit, since that is routine and callers decide what it means. */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts });
  if (res.error) return { ok: false, stdout: '', stderr: String(res.error.message ?? res.error), status: null };
  return { ok: res.status === 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status };
}

// Every git call runs with `-c core.longpaths=true` (needed on Windows, ignored elsewhere).
// `readLongpaths` below bypasses this deliberately to read the real persisted value.
const git = (args, opts) => run('git', ['-c', 'core.longpaths=true', ...args], opts);
const gitOut = (args, opts) => {
  const res = git(args, opts);
  return res.ok ? res.stdout.trim() : null;
};

// --- Pure functions (exported for this repository's own layer 1 checks) -----

/** Parses `git worktree list --porcelain` into one record per entry, main worktree first.
 *  `branch` is `null` for a detached HEAD. */
export function parsePorcelain(text) {
  const records = [];
  let cur = null;
  for (const line of (text ?? '').split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length).trim(), head: null, branch: null, locked: false, lockReason: null, detached: false };
      records.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line === 'locked' || line.startsWith('locked ')) {
      cur.locked = true;
      cur.lockReason = line === 'locked' ? null : line.slice('locked '.length).trim();
    }
  }
  return records;
}

/** The correlation ladder, first hit wins. Returns `{ number, rung }` or `null`. `#0` is
 *  explicitly not a correlation — never a real issue/pull-request number. */
export function correlate({ upstreamMergeRef, branch, dirBasename, headSubject }) {
  const fromRef = (ref) => {
    const m = /^refs\/heads\/(\d+)-/.exec(ref ?? '');
    return m ? Number(m[1]) : null;
  };

  const upstream = fromRef(upstreamMergeRef);
  if (upstream != null && upstream > 0) return { number: upstream, rung: 'upstream-branch' };

  const branchMatch = /^(\d+)-/.exec(branch ?? '');
  if (branchMatch && Number(branchMatch[1]) > 0) return { number: Number(branchMatch[1]), rung: 'branch-name' };

  const dirMatch = /^impl-(\d+)$/.exec(dirBasename ?? '');
  if (dirMatch && Number(dirMatch[1]) > 0) return { number: Number(dirMatch[1]), rung: 'directory-basename' };

  const subjectMatch = /^#(\d+)\b/.exec(headSubject ?? '');
  if (subjectMatch && Number(subjectMatch[1]) > 0) return { number: Number(subjectMatch[1]), rung: 'head-subject' };

  return null;
}

/** Classifies one candidate into exactly one state. Precedence: outside → protected → locked
 *  → dirty → active → done/no-work → unresolved. `isAncestor` only matters when `itemState` is `null`. */
export function classifyCandidate({ isOutside, isProtected, locked, dirty, itemState, isAncestor }) {
  if (isOutside) return { state: 'outside', removable: false };
  if (isProtected) return { state: 'active', removable: false };

  let base;
  if (itemState === 'OPEN') base = 'active';
  else if (itemState === 'CLOSED' || itemState === 'MERGED') base = 'done';
  else if (itemState == null && isAncestor === true) base = 'no-work';
  else base = 'unresolved';

  const otherwiseRemovable = base === 'done' || base === 'no-work';

  if (locked) return { state: 'locked', removable: false, otherwiseRemovable };
  if (otherwiseRemovable && dirty) return { state: 'dirty', removable: false, otherwiseRemovable: true };
  return { state: base, removable: otherwiseRemovable };
}

/** Strips the Windows extended-length path prefix (`\\?\`, or its UNC form) that a realpath
 *  call adds to some resolved paths and not others on win32. A no-op otherwise. */
export function stripExtendedPrefix(p) {
  if (p.startsWith('\\\\?\\UNC\\')) return '\\\\' + p.slice('\\\\?\\UNC\\'.length);
  if (p.startsWith('\\\\?\\')) return p.slice('\\\\?\\'.length);
  return p;
}

/** Resolves a path to the key its identity is compared by: `realpathSync.native` (it alone
 *  expands a Windows short-name alias), then on win32 stripped and lowercased. */
export function pathKey(p) {
  let r;
  try {
    r = realpathSync.native(p);
  } catch {
    r = resolve(p);
  }
  if (process.platform === 'win32') return stripExtendedPrefix(r).toLowerCase();
  return r;
}

/** Decides what `removeWorktree` does after `git worktree remove` has already been attempted
 *  once: gone → `done`; deregistered-but-present or unmoved HEAD → `fallback`; moved HEAD → `abort`. */
export function fallbackDecision({ dirExists, stillRegistered, headNow, headClassified }) {
  if (!dirExists) return { action: 'done' };
  if (!stillRegistered) return { action: 'fallback' };
  if (headNow === headClassified) return { action: 'fallback' };
  return { action: 'abort', reason: 'changed during removal' };
}

/** Classifies a filesystem error code from the `fs.rmSync` fallback into a cause a human can
 *  act on. `EBUSY`/`EPERM`/`EACCES`/`ENOTEMPTY` mean a file is still open; `ENAMETOOLONG` is Windows. */
export function classifyRemovalFailure(code) {
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY') return 'file-in-use';
  if (code === 'ENAMETOOLONG') return 'long-path';
  return 'unknown';
}

/** Removes one already-classified, removable candidate: `git worktree remove`, then
 *  `fallbackDecision`, then `fs.rmSync` as recovery. `deps` is the injectable test seam. */
export function removeWorktree(mainRoot, candidate, deps = {}) {
  const d = {
    git,
    rmSync,
    existsSync,
    listPorcelain: () => parsePorcelain(gitOut(['worktree', 'list', '--porcelain'], { cwd: mainRoot }) ?? ''),
    ...deps,
  };

  // stdio: ['ignore', ...] so Git for Windows' own retry prompt can never wait on stdin.
  const removeRes = d.git(['-C', mainRoot, 'worktree', 'remove', '--force', candidate.path], { stdio: ['ignore', 'pipe', 'pipe'] });
  const gitError = removeRes.ok ? null : (removeRes.stderr.trim().split('\n')[0] || 'git worktree remove failed');

  const dirExists = d.existsSync(candidate.path);
  const records = d.listPorcelain();
  const match = records.find((r) => pathKey(r.path) === pathKey(candidate.path));

  const decision = fallbackDecision({
    dirExists,
    stillRegistered: !!match,
    headNow: match ? match.head : null,
    headClassified: candidate.head,
  });

  if (decision.action === 'done') {
    return { removed: true, removedBy: 'git', gitError, error: null, cause: null };
  }

  if (decision.action === 'abort') {
    return { removed: false, removedBy: null, gitError, error: 'HEAD moved while it was being removed; not deleted.', cause: null };
  }

  // decision.action === 'fallback'
  try {
    d.rmSync(candidate.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return { removed: true, removedBy: 'fallback', gitError, error: null, cause: null };
  } catch (err) {
    return { removed: false, removedBy: null, gitError, error: err.message, cause: classifyRemovalFailure(err.code) };
  }
}

/** Classifies one directory beside a registered worktree. Tells a live independent repository
 *  (`.git` dir) from a worktree's own `.git` file whose target is now forgotten. */
export function orphanVerdict({ gitEntry, gitdirTargetExists }) {
  if (gitEntry === 'dir') return 'skip';
  if (gitEntry === 'unreadable') return 'skip';
  if (gitEntry === 'file') return gitdirTargetExists ? 'skip' : 'orphan';
  return 'orphan'; // gitEntry === 'none'
}

/** The Windows advisory copy, or `null` when it does not apply — only ever fires on win32
 *  with `core.longpaths` not already `'true'`. */
export function longPathAdvisory({ platform, longpaths }) {
  if (platform !== 'win32') return null;
  if (longpaths === 'true') return null;
  return 'core.longpaths is off — git on Windows cannot create or delete paths over 260 characters, which a populated node_modules under .claude/worktrees/ can exceed. Enable it once for this repository: git config core.longpaths true';
}

// --- gh --- `gh api graphql` exits non-zero whenever `errors` is present, even with usable
/** `data`, so this always returns the parsed body and fails only when nothing parses. */
function ghGraphql(query) {
  const res = run('gh', ['api', 'graphql', '-f', `query=${query}`]);
  const text = res.stdout || res.stderr;
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, body: null, error: res.stderr.trim().split('\n')[0] || 'gh api graphql produced no parseable output' };
  }
}

/** One `issueOrPullRequest(number:)` alias per number, in a single round trip. `null` means
 *  the alias came back `NOT_FOUND` or absent, never treated as done. */
function resolveStates(owner, name, numbers) {
  if (numbers.length === 0) return { ok: true, states: new Map() };
  const aliases = numbers.map((n) => `n${n}: issueOrPullRequest(number: ${n}) { __typename ... on Issue { state } ... on PullRequest { state } }`).join(' ');
  const query = `query { repository(owner: "${owner}", name: "${name}") { ${aliases} } }`;
  const { ok, body, error } = ghGraphql(query);
  if (!ok) return { ok: false, states: new Map(), error };
  const repoData = body?.data?.repository;
  const states = new Map();
  for (const n of numbers) {
    const node = repoData?.[`n${n}`];
    states.set(n, node?.state ?? null);
  }
  return { ok: true, states };
}

// --- git facts ------------------------------------------------------------
const worktreeList = (mainRoot) => gitOut(['worktree', 'list', '--porcelain'], { cwd: mainRoot });
const configRepoRoot = (path) => gitOut(['-C', path, 'rev-parse', '--show-toplevel']);

function readConfig(mainRoot) {
  const path = join(mainRoot, '.claude', 'port.config.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** `origin/<integration>` when the remote-tracking ref exists locally, else the local branch.
 *  Never fetches — a stale ref only makes `no-work` under-report, the safe direction. */
function resolveIntegrationRef(mainRoot, integration) {
  const remote = gitOut(['-C', mainRoot, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${integration}`]);
  if (remote) return `origin/${integration}`;
  const local = gitOut(['-C', mainRoot, 'rev-parse', '--verify', '--quiet', `refs/heads/${integration}`]);
  if (local) return integration;
  return null;
}

function isAncestorOfIntegration(mainRoot, sha, integrationRef) {
  const res = git(['-C', mainRoot, 'merge-base', '--is-ancestor', sha, integrationRef]);
  return res.status === 0;
}

function headSubjectOf(mainRoot, sha) {
  return gitOut(['-C', mainRoot, 'log', '-1', '--format=%s', sha]);
}

function upstreamMergeRefOf(mainRoot, branch) {
  if (!branch) return null;
  return gitOut(['-C', mainRoot, 'config', '--get', `branch.${branch}.merge`]);
}

/** A `git status --porcelain` failure fails toward dirty, not clean — the one check whose
 *  whole point is never discarding uncommitted work. `files: -1` marks "unknown count". */
function isDirty(path) {
  const res = git(['-C', path, 'status', '--porcelain']);
  if (!res.ok) return { dirty: true, files: -1 };
  const files = res.stdout.split('\n').filter((l) => l.trim() !== '').length;
  return { dirty: files > 0, files };
}

/** Reads the repository's own persisted `core.longpaths`, bypassing the `git` helper's
 *  `-c core.longpaths=true` override deliberately. `null` when unset or unreadable. */
function readLongpaths(mainRoot) {
  const res = run('git', ['-C', mainRoot, 'config', '--type=bool', '--get', 'core.longpaths']);
  return res.ok ? res.stdout.trim() : null;
}

// --- Orphan directories --- Gathers the one fact `orphanVerdict` needs about a candidate
/** directory's `.git` entry — the only I/O `findOrphanDirs` defers to this helper. */
function gitEntryOf(full) {
  const gitPath = join(full, '.git');
  let stat;
  try {
    stat = statSync(gitPath);
  } catch (e) {
    return e.code === 'ENOENT' ? { gitEntry: 'none', gitdirTargetExists: false } : { gitEntry: 'unreadable', gitdirTargetExists: false };
  }
  if (stat.isDirectory()) return { gitEntry: 'dir', gitdirTargetExists: false };
  try {
    const content = readFileSync(gitPath, 'utf8');
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(content);
    const target = m ? m[1] : null;
    return { gitEntry: 'file', gitdirTargetExists: !!target && existsSync(resolve(full, target)) };
  } catch {
    return { gitEntry: 'unreadable', gitdirTargetExists: false };
  }
}

/** Directories that sit beside a registered worktree but that git does not track at all —
 *  never deleted here, only reported. Also scans `.claude/worktrees/` itself when it exists. */
function findOrphanDirs(mainRoot, candidates) {
  const registered = new Set(candidates.map((c) => pathKey(c.path)));
  registered.add(pathKey(mainRoot));

  const parents = new Set(candidates.map((c) => dirname(resolve(c.path))));
  const worktreesDir = resolve(join(mainRoot, '.claude', 'worktrees'));
  if (existsSync(worktreesDir)) parents.add(worktreesDir);

  const found = new Map();
  for (const parent of parents) {
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent)) {
      const full = resolve(join(parent, entry));
      const key = pathKey(full);
      if (registered.has(key) || found.has(key)) continue;
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      if (orphanVerdict(gitEntryOf(full)) !== 'orphan') continue;
      found.set(key, full);
    }
  }
  return [...found.values()];
}

// --- CLI ----------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { issue: null, max: 5, protect: [], offline: false, json: false, unlock: false, forceDirty: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--issue') opts.issue = Number(argv[++i]);
    else if (a === '--max') opts.max = Number(argv[++i]);
    else if (a === '--protect') opts.protect.push(argv[++i]);
    else if (a === '--offline') opts.offline = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--unlock') opts.unlock = true;
    else if (a === '--force-dirty') opts.forceDirty = true;
    else die(`unrecognized argument '${a}'. ${USAGE}`);
  }
  return opts;
}

/** `purge --orphan <path>... [--json]` — needs only git. Re-derives this run's own orphan
 *  set and deletes a requested path only when it is a member; anything else is refused. */
function runPurge(argv) {
  const paths = [];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--orphan') paths.push(argv[++i]);
    else if (a === '--json') json = true;
    else die(`unrecognized argument '${a}'. ${USAGE}`);
  }
  if (paths.length === 0) die(`purge requires at least one --orphan <path>. ${USAGE}`);

  const mainRoot = configRepoRoot(process.cwd());
  if (!mainRoot) die('not a git repository (git rev-parse --show-toplevel failed).');

  const porcelain = worktreeList(mainRoot);
  if (porcelain === null) die('`git worktree list --porcelain` failed.');
  const records = parsePorcelain(porcelain);
  if (records.length === 0) die('`git worktree list --porcelain` produced no entries — not a git repository?');

  const mainResolved = resolve(records[0].path);
  const candidates = records.slice(1).map((r) => {
    const relPath = relative(mainResolved, resolve(r.path));
    const isOutside = relPath === '' || relPath.startsWith('..') || isAbsolute(relPath);
    return { ...r, isOutside };
  });
  const orphanKeys = new Set(findOrphanDirs(mainRoot, candidates.filter((c) => !c.isOutside)).map(pathKey));

  const results = [];
  let anyFailed = false;
  for (const p of paths) {
    if (!orphanKeys.has(pathKey(p))) {
      results.push({ path: p, deleted: false, refused: "not an orphan directory in this run's report; never deleted", error: null, cause: null });
      anyFailed = true;
      continue;
    }
    try {
      rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      results.push({ path: p, deleted: true, refused: null, error: null, cause: null });
    } catch (err) {
      results.push({ path: p, deleted: false, refused: null, error: err.message, cause: classifyRemovalFailure(err.code) });
      anyFailed = true;
    }
  }

  if (json) {
    console.log(JSON.stringify({ mainRoot, results }, null, 2));
  } else {
    for (const r of results) {
      if (r.deleted) console.log(`deleted\t${r.path}`);
      else if (r.refused) console.log(`refused\t${r.path} — ${r.refused}`);
      else console.log(`failed\t${r.path} — ${r.error}`);
    }
  }
  process.exit(anyFailed ? 2 : 0);
}

function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === 'purge') {
    runPurge(rest);
    return;
  }
  if (mode !== 'report' && mode !== 'reclaim') {
    die(`unrecognized mode. ${USAGE}`);
  }
  const opts = parseArgs(rest);

  const mainRoot = configRepoRoot(process.cwd());
  if (!mainRoot) die('not a git repository (git rev-parse --show-toplevel failed).');

  const advisories = [];
  const advisory = longPathAdvisory({ platform: process.platform, longpaths: readLongpaths(mainRoot) });
  if (advisory) advisories.push(advisory);

  const cfg = readConfig(mainRoot);
  if (!cfg) die('.claude/port.config.json was not found, or does not parse, at the repository root — this repository is not port-managed.');
  const integration = cfg.branches?.integration ?? 'dev';
  const repo = cfg.repo;
  if (!repo) die('.claude/port.config.json declares no `repo`.');
  const [owner, name] = repo.split('/');

  // Resolving the integration ref and ancestry are purely local git facts, so neither is
  // gated on `--offline`; only the gh resolution below is.
  const integrationRef = resolveIntegrationRef(mainRoot, integration);
  if (!integrationRef) {
    die(`neither 'origin/${integration}' nor a local '${integration}' branch exists — the 'no-work' rung has nothing to compare against.`);
  }

  const porcelain = worktreeList(mainRoot);
  if (porcelain === null) die('`git worktree list --porcelain` failed.');
  const records = parsePorcelain(porcelain);
  if (records.length === 0) die('`git worktree list --porcelain` produced no entries — not a git repository?');

  const mainResolved = resolve(records[0].path);
  const protectedSet = new Set(opts.protect.map((p) => pathKey(p)));

  const candidates = records.slice(1).map((r) => {
    const relPath = relative(mainResolved, resolve(r.path));
    const isOutside = relPath === '' || relPath.startsWith('..') || isAbsolute(relPath);
    return { ...r, isOutside };
  });

  // Correlate every candidate not fenced out.
  for (const c of candidates) {
    if (c.isOutside) {
      c.correlation = null;
      continue;
    }
    const upstreamMergeRef = c.branch ? upstreamMergeRefOf(mainRoot, c.branch) : null;
    const headSubject = c.head ? headSubjectOf(mainRoot, c.head) : null;
    c.correlation = correlate({ upstreamMergeRef, branch: c.branch, dirBasename: basename(c.path), headSubject });
  }

  // Resolve every correlated number in one round trip.
  const numbers = [...new Set(candidates.filter((c) => c.correlation).map((c) => c.correlation.number))];
  let states = new Map();
  if (!opts.offline && numbers.length > 0) {
    const result = resolveStates(owner, name, numbers);
    if (!result.ok) die(`gh issueOrPullRequest resolution failed: ${result.error}`);
    states = result.states;
  }

  // Ancestor check for every uncorrelated, non-outside candidate — local git
  // only, so this runs the same whether or not --offline was passed.
  for (const c of candidates) {
    if (c.isOutside || c.correlation) continue;
    c.isAncestor = !c.head ? null : isAncestorOfIntegration(mainRoot, c.head, integrationRef);
  }

  // Classify every candidate, `outside` ones included — the report must be fully populated for it too.
  for (const c of candidates) {
    if (c.isOutside) {
      const classified = classifyCandidate({ isOutside: true, isProtected: false, locked: false, dirty: false, itemState: null, isAncestor: null });
      c.itemState = null;
      c.dirtyFiles = 0;
      c.state = classified.state;
      c.otherwiseRemovable = false;
      c.removable = false;
      c.reason = describeReason(c);
      continue;
    }

    const itemState = c.correlation ? states.get(c.correlation.number) ?? null : null;
    const base = classifyCandidate({
      isOutside: false,
      isProtected: false,
      locked: false,
      dirty: false,
      itemState,
      isAncestor: c.isAncestor ?? null,
    });
    const shouldCheckDirty = base.removable || c.locked;
    const dirtyInfo = shouldCheckDirty ? isDirty(c.path) : { dirty: false, files: 0 };
    c.itemState = itemState;
    c.dirtyFiles = dirtyInfo.files;
    const classified = classifyCandidate({
      isOutside: c.isOutside,
      isProtected: protectedSet.has(pathKey(c.path)),
      locked: c.locked && !opts.unlock,
      dirty: dirtyInfo.dirty && !opts.forceDirty,
      itemState,
      isAncestor: c.isAncestor ?? null,
    });
    c.state = classified.state;
    c.otherwiseRemovable = classified.otherwiseRemovable ?? false;
    c.removable = classified.removable && (opts.issue == null || c.correlation?.number === opts.issue);
    c.reason = describeReason(c);
  }

  // Removal (reclaim only), oldest first by directory mtime, capped at --max.
  let removedCount = 0;
  let removalFailed = false;
  if (mode === 'reclaim') {
    const removable = candidates
      .filter((c) => c.removable)
      .sort((a, b) => mtimeOf(a.path) - mtimeOf(b.path));
    for (const c of removable) {
      if (removedCount >= opts.max) break;
      if (c.locked && opts.unlock) {
        const unlockRes = git(['-C', mainRoot, 'worktree', 'unlock', c.path]);
        if (!unlockRes.ok) {
          c.error = `unlock failed: ${unlockRes.stderr.trim()}`;
          c.failureKind = 'unlock';
          removalFailed = true;
          continue;
        }
      }
      const result = removeWorktree(mainRoot, c);
      c.removedBy = result.removedBy;
      c.gitError = result.gitError;
      c.cause = result.cause;
      if (result.removed) {
        c.removed = true;
        removedCount++;
        // Runs after either route, `git` or `fallback` — not only after a
        // clean `git worktree remove`.
        if (c.branch) {
          const branchRes = git(['-C', mainRoot, 'branch', '-d', c.branch]);
          c.branchDeleted = branchRes.ok;
          if (!branchRes.ok) c.branchRetainedReason = branchRes.stderr.trim().split('\n')[0] || 'unmerged';
        }
      } else {
        c.error = result.error;
        c.failureKind = result.cause ? 'failed' : 'kept';
        removalFailed = true;
      }
    }
    git(['-C', mainRoot, 'worktree', 'prune']);
  }

  const orphanDirs = findOrphanDirs(mainRoot, candidates.filter((c) => !c.isOutside));

  report({ mode, mainRoot, integrationRef, candidates, orphanDirs, opts, advisories });
  process.exit(removalFailed ? 2 : 0);
}

function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function describeReason(c) {
  switch (c.state) {
    case 'active':
      return c.itemState === 'OPEN' ? `#${c.correlation.number} open` : 'protected';
    case 'done':
      return `#${c.correlation.number} ${c.itemState === 'MERGED' ? 'merged' : 'closed'} (${c.correlation.rung})`;
    case 'no-work':
      return `no work not already on the integration branch`;
    case 'locked': {
      const base = c.lockReason ? `locked: ${c.lockReason}` : 'locked';
      // Only ever call this reclaimable when the item is actually done/no-work — an operator
      // must never be walked into unlocking a live agent's worktree.
      if (!c.otherwiseRemovable) return base;
      const dirtyClause =
        c.dirtyFiles === -1
          ? '; uncommitted status could not be checked too'
          : c.dirtyFiles > 0
            ? `; ${c.dirtyFiles} uncommitted file(s) too`
            : '';
      const forcedFlag = c.dirtyFiles !== 0 ? ' and forced' : '';
      return `${base}${dirtyClause} — reclaimable once unlocked${dirtyClause ? forcedFlag : ''}: git worktree unlock "${c.path}"`;
    }
    case 'dirty': {
      const prefix = c.correlation ? `#${c.correlation.number} ` : '';
      const count = c.dirtyFiles === -1 ? 'an unknown number of' : c.dirtyFiles;
      return `${prefix}otherwise reclaimable, but ${count} uncommitted file(s)`;
    }
    case 'outside':
      return 'registered path is outside the main worktree — never touched';
    case 'unresolved':
    default:
      return c.correlation
        ? `#${c.correlation.number} could not be resolved`
        : 'no upstream branch, no #N subject, and HEAD is not on the integration branch';
  }
}

function report({ mode, mainRoot, integrationRef, candidates, orphanDirs, opts, advisories }) {
  const visible = candidates;
  const removed = visible.filter((c) => c.removed).length;
  const kept = visible.length - removed;
  const byState = {};
  for (const c of visible) byState[c.state] = (byState[c.state] ?? 0) + 1;

  if (opts.json) {
    console.log(JSON.stringify({
      mainRoot,
      integrationRef,
      advisories,
      candidates: visible.map((c) => ({
        path: c.path,
        branch: c.branch,
        head: c.head,
        state: c.state,
        reason: c.reason,
        rung: c.correlation?.rung ?? null,
        issue: c.correlation?.number ?? null,
        locked: c.locked,
        lockReason: c.lockReason,
        dirtyFiles: c.dirtyFiles ?? 0,
        removed: !!c.removed,
        removedBy: c.removedBy ?? null,
        gitError: c.gitError ?? null,
        cause: c.cause ?? null,
        branchDeleted: c.branchDeleted ?? null,
        error: c.error ?? null,
      })),
      orphanDirs,
      summary: { registered: visible.length, removed, kept, byState },
    }, null, 2));
    return;
  }

  for (const a of advisories) console.log(`advisory  ${a}`);

  console.log(`Worktrees: ${visible.length} registered · removed ${removed} · kept ${kept}.`);
  for (const c of visible) {
    if (c.removed) {
      const suffix = c.removedBy === 'fallback'
        ? ` · git worktree remove failed (${c.gitError ?? 'unknown error'}); removed by the filesystem fallback`
        : '';
      console.log(`removed\t${c.path} — ${c.reason}${suffix}`);
    } else if (c.failureKind === 'kept') {
      console.log(`kept\t${c.path} — ${c.error}`);
    } else if (c.failureKind === 'failed') {
      const msg = c.cause === 'file-in-use'
        ? `a file under it is still open (${c.error}). Close whatever holds it (an editor, a dev server, an antivirus scan), then run /port:worktree-clean.`
        : `${c.error}. Run /port:worktree-clean to retry.`;
      console.log(`failed\t${c.path} — ${msg}`);
    } else {
      const suffix = c.error ? ` — FAILED: ${c.error}` : '';
      console.log(`${c.state}\t${c.path} — ${c.reason}${suffix}`);
    }
    if (c.removed && c.branch && c.branchDeleted === false) {
      console.log(`  branch '${c.branch}' retained — ${c.branchRetainedReason}`);
    }
  }
  if (orphanDirs.length > 0) {
    console.log(`${orphanDirs.length} orphan directory(ies), untracked, never deleted here: ${orphanDirs.join(', ')} — run /port:worktree-clean.`);
  }
  const unresolved = visible.filter((c) => c.state === 'unresolved');
  if (unresolved.length > 0) {
    console.log(`${unresolved.length} unresolved (${unresolved.map((c) => basename(c.path)).join(', ')}) — run /port:worktree-clean.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
