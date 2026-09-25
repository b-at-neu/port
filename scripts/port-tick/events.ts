// The trajectory record's emitter: one append-only JSONL line per event, to
// `.agents/events.jsonl` (gitignored — `.agents/` already is). #187: the
// pipeline had no machine-readable record of its own runs, only prose and
// GitHub state. Write-only from here — nothing under scripts/port-tick/
// other than report.ts may read this file back, mechanically pinned by
// scripts/checks/tick.ts's write-only rail: an append-only history that fed
// a future decision would quietly break #203's invariant that `plan` never
// persists anything a later tick reads. That is also why this module exports
// no function whose name contains `read` or `parse`.
import { appendFileSync, existsSync, statSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const EVENTS_PATH = '.agents/events.jsonl';
export const EVENTS_PREV_PATH = '.agents/events.1.jsonl';

const MAX_LINE_BYTES = 8 * 1024;
const ROTATE_AT_BYTES = 8 * 1024 * 1024;

/** Pure: builds one envelope-plus-payload line, capped at `MAX_LINE_BYTES`.
 *  `envelope` carries `{v, ts, runId, repo, kind}`; `payload` is the kind's
 *  own fields. When the encoded line is over the cap, the largest array-
 *  valued payload field is repeatedly halved until it fits, and the line is
 *  stamped `truncated: true` — never the envelope fields themselves, and
 *  never a throw. Returns the line's JSON string, with no trailing newline
 *  (`appendEvent` adds it). */
export function formatEvent(envelope: any, payload: Record<string, any> = {}): string {
  const full = { ...envelope, ...payload };
  const line = JSON.stringify(full);
  if (Buffer.byteLength(line, 'utf8') <= MAX_LINE_BYTES) return line;

  const arrayKeys = Object.keys(payload).filter((k) => Array.isArray(payload[k]));
  const shrunk: Record<string, any> = { ...payload };
  let guard = 0;
  const fits = () => Buffer.byteLength(JSON.stringify({ ...envelope, ...shrunk, truncated: true }), 'utf8') <= MAX_LINE_BYTES;
  while (!fits() && guard < 50) {
    guard += 1;
    let longestKey: string | null = null;
    let longestLen = 0;
    for (const k of arrayKeys) {
      const len = Array.isArray(shrunk[k]) ? shrunk[k].length : 0;
      if (len > longestLen) {
        longestLen = len;
        longestKey = k;
      }
    }
    if (!longestKey || longestLen === 0) break;
    shrunk[longestKey] = shrunk[longestKey].slice(0, Math.ceil(longestLen / 2));
  }
  if (fits()) return JSON.stringify({ ...envelope, ...shrunk, truncated: true });

  // Still over the cap with nothing left to shrink — drop every array-valued
  // field to empty rather than emit a line long enough to split under two
  // cockpits' concurrent whole-line appends. Non-array payload fields are
  // kept as-is: only array-valued fields are ever capped.
  const minimal: Record<string, any> = { ...envelope, ...payload, truncated: true };
  for (const k of arrayKeys) minimal[k] = [];
  return JSON.stringify(minimal);
}

/** The only I/O in this module. Appends `event` (a `formatEvent` string, or
 *  the object it would encode) plus `\n` to `.agents/events.jsonl` under
 *  `root`, creating `.agents/` if needed. Swallows every failure — a
 *  disk-full or permissions error must never fail a tick; the resulting gap
 *  surfaces in `report.ts` as a gap, never as a clean run. */
export function appendEvent(root: string, event: string | any): void {
  try {
    const path = join(root, EVENTS_PATH);
    mkdirSync(dirname(path), { recursive: true });
    const line = typeof event === 'string' ? event : JSON.stringify(event);
    appendFileSync(path, `${line}\n`, 'utf8');
  } catch {
    // Deliberately swallowed — see header comment.
  }
}

/** Pure: whether `.agents/events.jsonl` should rotate before a fresh run
 *  starts. Rotates at or over `capBytes` (default 8 MB), never under — the
 *  boundary layer 1 pins so it cannot silently drift in either direction. */
export function rotationDecision(sizeBytes: number, capBytes = ROTATE_AT_BYTES): boolean {
  return sizeBytes >= capBytes;
}

/** The only caller of `rotationDecision` that touches the filesystem, run
 *  once by `start` and never mid-tick, so one run's records are never split
 *  across a rotation. Replaces any previous `events.1.jsonl` outright — two
 *  generations, ~16 MB ceiling (docs/TESTING.md → "Trajectory record"). */
export function rotateIfNeeded(root: string): void {
  const path = join(root, EVENTS_PATH);
  if (!existsSync(path)) return;
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (!rotationDecision(size)) return;
  try {
    renameSync(path, join(root, EVENTS_PREV_PATH));
  } catch {
    // A failed rotation degrades to one oversized generation, never a lost
    // tick — the same fail-open direction as appendEvent above.
  }
}

/** The shared envelope every event kind opens with — one place composing
 *  `{v, ts, runId, repo, kind}` so every call site in port-tick.ts is a
 *  single line into this module, per docs/ENGINEERING.md §7's small-file
 *  discipline (the CLI entry has 28 lines of headroom at most). */
export function envelopeFor(kind: string, runId: string | null, repo: string, ts?: string | null): any {
  return { v: 1, ts: ts ?? new Date().toISOString(), runId: runId ?? null, repo, kind };
}

/** `run-start`'s own fields — the config facts that make a run
 *  interpretable on their own, without cross-referencing `.claude/port.config.json`
 *  as it stood when the run happened. */
export function runStartPayload(cfg: any): any {
  return {
    engine: 'port-tick',
    node: process.version,
    models: cfg.models,
    reviewCycleCap: cfg.reviewCycleCap,
    overlapThreshold: cfg.concurrency.overlapThreshold,
    modules: cfg.modules,
    labelsOverridden: cfg.labelsOverridden,
    budgetConfigured: cfg.budgetConfigured,
  };
}

/** `tick`'s own fields, built from `cmdPlan`'s own locals — reused as-is for
 *  a blind tick, which passes only `tickId` and `envelope` and gets sensible
 *  empty defaults for the rest rather than a second, near-duplicate shape. */
export function tickEventPayload({
  tickId,
  envelope,
  items,
  livenessExpected,
  dispatch,
  gates,
  held,
  announce,
  writes,
  wakeup,
  rateLimit,
  denials,
}: {
  tickId: string | null;
  envelope: any;
  items?: any;
  livenessExpected?: any[];
  dispatch?: any[];
  gates?: any[];
  held?: any[];
  announce?: any[];
  writes?: any[];
  wakeup?: number;
  rateLimit?: any;
  denials?: any;
}): any {
  return {
    tickId,
    envelope,
    counts: Object.fromEntries(Object.entries<any>(items?.mine ?? {}).map(([k, v]) => [k, v.length])),
    liveItems: (livenessExpected ?? []).map((e: any) => ({ item: e.item, stage: e.stage })),
    planned: {
      dispatch: (dispatch ?? []).map((d: any) => ({ stage: d.stage, item: d.item, model: d.model })),
      gates: (gates ?? []).map((g: any) => ({ kind: g.kind, item: g.item })),
      held: (held ?? []).map((h: any) => ({ item: h.item, blocker: h.blocker, blockerLabel: h.blockerLabel, depth: h.depth, contendedPaths: h.contendedPaths ?? [] })),
      announce: (announce ?? []).map((a: any) => ({ kind: a.kind, item: a.item })),
      writes: (writes ?? []).length,
    },
    wakeupProposed: wakeup,
    rateLimit,
    denials,
  };
}
