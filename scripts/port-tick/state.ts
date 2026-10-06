// Reads and writes the two state files under gitignored `.temp/`: tick state and the
// dispatch log. Each carries a `repo` field treated as absent when it names a different one.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const TICK_STATE_PATH = '.temp/tick-state.json';
export const DISPATCH_LOG_PATH = '.temp/dispatch-log.json';

/** 12 hex characters — enough to make a `runId` collision a non-concern; never a session id. */
export function newRunId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

/** Reads a JSON state file at `relPath`. Returns `null` when absent, unparseable, or its
 *  `repo` field names a different repository — all three treated as absent, never trusted. */
export function readState(repoRoot: string, relPath: string, repo: string): any {
  const path = join(repoRoot, relPath);
  if (!existsSync(path)) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (parsed.repo !== repo) return null;
  return parsed;
}

/** Writes `data` to `relPath` under `repoRoot`, creating `.temp/` if needed. */
export function writeState(repoRoot: string, relPath: string, data: any): void {
  const path = join(repoRoot, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/** A fresh tick-state record, as `start` writes it. */
export function freshTickState(repo: string): any {
  return {
    repo,
    runId: newRunId(),
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
    unknownStreak: {},
    // An older state file lacks these; every read is `?? []`, so the first tick after
    // upgrading reports everything once rather than crashing on a missing field.
    contradictionsReported: [],
    duplicatesReported: [],
    orphansReported: [],
  };
}

/** A fresh dispatch-log record. `items` is keyed by issue/PR number (string) to `{ stage, state, resets }`. */
export function freshDispatchLog(repo: string): any {
  return { repo, items: {} };
}
