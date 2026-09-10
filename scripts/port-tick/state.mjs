// Reads and writes the two state files under the gitignored `.temp/`: tick
// state (the pacing ladder, the resume clock, the denial-log offset, the
// remembered report sets) and the dispatch log (this session's own proof of
// what it dispatched, per plugins/port/docs/PIPELINE.md → "Liveness"). Each
// carries a `repo` field treated as absent when it names a different
// repository — a `start` rewrites both fresh, and that overwrite *is* the
// session scoping, no clock or session id needed.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const TICK_STATE_PATH = '.temp/tick-state.json';
export const DISPATCH_LOG_PATH = '.temp/dispatch-log.json';

/** Reads a JSON state file at `relPath` under `repoRoot`. Returns `null`
 *  when the file is absent, unparseable, or its `repo` field names a
 *  different repository than `repo` — all three are "treated as absent",
 *  never trusted. */
export function readState(repoRoot, relPath, repo) {
  const path = join(repoRoot, relPath);
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (parsed.repo !== repo) return null;
  return parsed;
}

/** Writes `data` to `relPath` under `repoRoot`, creating `.temp/` if needed. */
export function writeState(repoRoot, relPath, data) {
  const path = join(repoRoot, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/** A fresh tick-state record, as `start` writes it. */
export function freshTickState(repo) {
  return {
    repo,
    lastTick: null,
    scheduled: null,
    cadenceStep: 0,
    noChangeTicks: 0,
    denialsConsumed: 0,
    announcedApproved: [],
    unownedReported: [],
    ungatedReported: [],
    worktreesReported: null,
    uncorrelatableAnnounced: false,
    pluginStaleness: null,
    refreshed: {},
  };
}

/** A fresh dispatch-log record, as `start` writes it. `items` is keyed by
 *  issue/pull-request number (as a string, for stable JSON round-tripping)
 *  to `{ stage, state, resets }`. */
export function freshDispatchLog(repo) {
  return { repo, items: {} };
}
