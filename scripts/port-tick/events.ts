// The trajectory record's emitter: one append-only JSONL line per event. Write-only from
// here — nothing but report.ts may read it back, so this module exports no `read`/`parse`.
import { appendFileSync, existsSync, statSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const EVENTS_PATH = '.agents/events.jsonl';
export const EVENTS_PREV_PATH = '.agents/events.1.jsonl';

const MAX_LINE_BYTES = 8 * 1024;
const ROTATE_AT_BYTES = 8 * 1024 * 1024;

/** Pure: builds one envelope-plus-payload line, capped at `MAX_LINE_BYTES` by repeatedly
 *  halving the largest array-valued payload field and stamping `truncated: true`. */
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

  // Still over the cap — drop every array-valued field rather than emit an overlong line.
  const minimal: Record<string, any> = { ...envelope, ...payload, truncated: true };
  for (const k of arrayKeys) minimal[k] = [];
  return JSON.stringify(minimal);
}

/** The only I/O in this module. Swallows every failure — a disk-full tick must still run. */
export function appendEvent(root: string, event: string | any): void {
  try {
    const path = join(root, EVENTS_PATH);
    mkdirSync(dirname(path), { recursive: true });
    const line = typeof event === 'string' ? event : JSON.stringify(event);
    appendFileSync(path, `${line}\n`, 'utf8');
  } catch {
    // Deliberately swallowed — see module header.
  }
}

/** Pure: whether `.agents/events.jsonl` should rotate. At or over `capBytes`, never under. */
export function rotationDecision(sizeBytes: number, capBytes = ROTATE_AT_BYTES): boolean {
  return sizeBytes >= capBytes;
}

/** The only caller of `rotationDecision` that touches the filesystem, run once by `start`. */
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
    // A failed rotation degrades to one oversized generation, never a lost tick.
  }
}

/** The shared envelope every event kind opens with. */
export function envelopeFor(kind: string, runId: string | null, repo: string, ts?: string | null): any {
  return { v: 1, ts: ts ?? new Date().toISOString(), runId: runId ?? null, repo, kind };
}

/** `run-start`'s own fields — the config facts that make a run interpretable on their own. */
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
    overrides: { applied: cfg.overrides?.applied ?? [], refused: cfg.overrides?.refused ?? [] },
  };
}

/** `tick`'s own fields, reused as-is for a blind tick (`tickId`/`envelope` only, rest default). */
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
    // Same shape as counts, from items.others/items.unowned — without these an ownership divergence has nothing to diff against.
    othersCounts: Object.fromEntries(Object.entries<any>(items?.others ?? {}).map(([k, v]) => [k, v.length])),
    unownedCounts: Object.fromEntries(Object.entries<any>(items?.unowned ?? {}).map(([k, v]) => [k, v.length])),
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
