// computeParity: a pure diff between the cockpit's own trajectory record
// (.agents/events.jsonl, already parsed by report.ts's parseEventLines) and
// the desktop app's parallel one (.agents/desktop-events.jsonl, appended by
// apps/desktop/src/main/trajectory/log.ts) — #111's parity harness. A diff
// function takes already-parsed arrays and never reads a file itself, the
// same reasoning the write-only rail already applies one level up
// (docs/ENGINEERING.md §1): this file imports neither events.ts nor
// report.ts, mechanically pinned by scripts/checks/tick-parity.ts.
//
// "Not a full dispatch-parity proof" (the plan's own words): until #98/#101
// land, the desktop app never actually calls its dispatch ledger, so parity
// here means "would the app's decision have matched the cockpit's action" —
// item numbers and stage names, never a live re-derivation of either side.

export const DEFAULT_WINDOW_SECONDS = 270;

/** The six trigger-stage aliases a tick's own ownership partition can hold
 *  `unowned`/`other-operator` for — gate and in-flight aliases (planReview,
 *  blocked, approved, needsHuman, planning, inProgress, reviewing, revising,
 *  refreshing, prOpened) never appear in either side's held set for these
 *  two reasons, so they are excluded rather than compared as a false zero. */
const OWNERSHIP_TRIGGER_KEYS = ['ready', 'planChangesRequested', 'planApproved', 'readyForReview', 'needsRevision', 'refreshBranch'];

function sortedEqual(a: readonly string[], b: readonly string[]): boolean {
  const as = [...a].sort();
  const bs = [...b].sort();
  return as.length === bs.length && as.every((v, i) => v === bs[i]);
}

/** Cockpit `planned.dispatch` (`{item, stage, model}`) against the app's
 *  `dispatch` (`{item, stage: `${agent}-agent`}`, `model` absent until a
 *  future ticket wires it through) — `extra-app`/`missing-app` by item
 *  number, `stage-mismatch`/`model-mismatch` on the ones present on both
 *  sides. `model-mismatch` only ever fires when the app side actually
 *  carries a `model` field — real desktop events never do yet, so this is
 *  forward-compatible rather than a false positive on every pair today. */
function diffDispatch(cockpitDispatch: readonly any[], appDispatch: readonly any[]): any {
  const cockpitByItem = new Map(cockpitDispatch.map((d) => [d.item, d]));
  const appByItem = new Map(appDispatch.map((d) => [d.item, d]));
  const extraApp: number[] = [];
  const missingApp: number[] = [];
  const mismatches: any[] = [];

  for (const [item, appEntry] of appByItem) {
    const cockpitEntry = cockpitByItem.get(item);
    if (!cockpitEntry) {
      extraApp.push(item);
      continue;
    }
    const kinds: string[] = [];
    if (appEntry.stage !== cockpitEntry.stage) kinds.push('stage-mismatch');
    if (appEntry.model !== undefined && cockpitEntry.model !== undefined && appEntry.model !== cockpitEntry.model) kinds.push('model-mismatch');
    if (kinds.length) mismatches.push({ item, kinds, cockpit: cockpitEntry, app: appEntry });
  }
  for (const [item] of cockpitByItem) {
    if (!appByItem.has(item)) missingApp.push(item);
  }

  return { extraApp: extraApp.sort((a, b) => a - b), missingApp: missingApp.sort((a, b) => a - b), mismatches };
}

/** Cockpit's `held` (contention-only, impl candidates alone — port-tick.ts's
 *  own `held` array never carries any other reason) against the app's
 *  `held` filtered to `reason === 'contended'`; same shape of diff, plus
 *  `blocker`/`depth`/`paths` mismatches on items present on both sides. */
function diffContention(cockpitHeld: readonly any[], appHeld: readonly any[]): any {
  const appContended = appHeld.filter((h) => h.reason === 'contended');
  const cockpitByItem = new Map(cockpitHeld.map((h) => [h.item, h]));
  const appByItem = new Map(appContended.map((h) => [h.item, h]));
  const extraApp: number[] = [];
  const missingApp: number[] = [];
  const mismatches: any[] = [];

  for (const [item, appEntry] of appByItem) {
    const cockpitEntry = cockpitByItem.get(item);
    if (!cockpitEntry) {
      extraApp.push(item);
      continue;
    }
    const kinds: string[] = [];
    const appContention = appEntry.contention ?? {};
    if (appContention.blocker !== cockpitEntry.blocker) kinds.push('blocker-mismatch');
    if (appContention.depth !== cockpitEntry.depth) kinds.push('depth-mismatch');
    if (!sortedEqual(appContention.paths ?? [], cockpitEntry.contendedPaths ?? [])) kinds.push('paths-mismatch');
    if (kinds.length) mismatches.push({ item, kinds, cockpit: cockpitEntry, app: appEntry });
  }
  for (const [item] of cockpitByItem) {
    if (!appByItem.has(item)) missingApp.push(item);
  }

  return { extraApp: extraApp.sort((a, b) => a - b), missingApp: missingApp.sort((a, b) => a - b), mismatches };
}

/** Cockpit's `othersCounts`/`unownedCounts` (per-alias counts, `events.ts`'s
 *  own new fields) against the app's `held` filtered to
 *  `reason === 'unowned' | 'other-operator'`, counted only — the cockpit's
 *  own trajectory record never lists item numbers for these two
 *  partitions, only counts, so this diff can name a *count* disagreement,
 *  never a specific item. */
function diffOwnership(cockpitOthersCounts: Record<string, number> | undefined, cockpitUnownedCounts: Record<string, number> | undefined, appHeld: readonly any[]): any {
  const appOthers: Record<string, number> = {};
  const appUnowned: Record<string, number> = {};
  for (const key of OWNERSHIP_TRIGGER_KEYS) {
    appOthers[key] = 0;
    appUnowned[key] = 0;
  }
  for (const h of appHeld) {
    if (!OWNERSHIP_TRIGGER_KEYS.includes(h.trigger)) continue;
    if (h.reason === 'other-operator') appOthers[h.trigger] += 1;
    else if (h.reason === 'unowned') appUnowned[h.trigger] += 1;
  }

  const mismatches: any[] = [];
  for (const key of OWNERSHIP_TRIGGER_KEYS) {
    const cockpitOther = cockpitOthersCounts?.[key] ?? 0;
    const appOther = appOthers[key] ?? 0;
    if (cockpitOther !== appOther) mismatches.push({ trigger: key, class: 'other-operator', cockpit: cockpitOther, app: appOther });

    const cockpitUnowned = cockpitUnownedCounts?.[key] ?? 0;
    const appUnownedCount = appUnowned[key] ?? 0;
    if (cockpitUnowned !== appUnownedCount) mismatches.push({ trigger: key, class: 'unowned', cockpit: cockpitUnowned, app: appUnownedCount });
  }

  return { mismatches };
}

export interface ComputeParityOptions {
  readonly windowSeconds?: number;
}

/** The whole diff. `cockpitEvents`/`desktopEvents` are already-parsed JSONL
 *  lines (whatever shape `report.ts`'s `parseEventLines` and its own
 *  desktop-side counterpart produce) — this function performs no I/O and
 *  assumes nothing about how either array reached it.
 *
 *  Pairing: filters `cockpitEvents` to `kind === 'tick'` with a non-blind
 *  envelope, then for each collects every `desktopEvents` entry for the
 *  same `repo` within `windowSeconds` of its `ts`; nearest `ts` wins. No
 *  candidate in the window is an `unmatchedCockpit` entry, never silently
 *  dropped. Every `desktopEvents` entry never picked as a nearest match for
 *  any cockpit tick is `unmatchedDesktop` — a desktop-only reading (the
 *  cockpit was not ticking, or was ticking a different repo) is itself
 *  worth surfacing, never folded into "0 divergences". An empty `pairs`
 *  array is therefore distinguished from "everything agreed" by checking
 *  `unmatchedCockpit`/`unmatchedDesktop` first. */
export function computeParity(cockpitEvents: readonly any[], desktopEvents: readonly any[], options: ComputeParityOptions = {}): any {
  const windowSeconds = options.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  const cockpitTicks = cockpitEvents.filter((e) => e != null && e.kind === 'tick' && e.envelope?.kind !== 'blind');

  const pairs: any[] = [];
  const unmatchedCockpit: any[] = [];
  const usedDesktopIndexes = new Set<number>();

  for (const tick of cockpitTicks) {
    const tickMs = Date.parse(tick.ts);
    let bestIdx = -1;
    let bestDelta = Infinity;
    desktopEvents.forEach((event, idx) => {
      if (event.repo !== tick.repo) return;
      const eventMs = Date.parse(event.ts);
      if (Number.isNaN(eventMs) || Number.isNaN(tickMs)) return;
      const delta = Math.abs(eventMs - tickMs) / 1000;
      if (delta > windowSeconds) return;
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIdx = idx;
      }
    });

    if (bestIdx === -1) {
      unmatchedCockpit.push({ tickId: tick.tickId ?? null, ts: tick.ts, repo: tick.repo });
      continue;
    }
    usedDesktopIndexes.add(bestIdx);
    const desktop = desktopEvents[bestIdx];
    pairs.push({
      cockpitTs: tick.ts,
      desktopTs: desktop.ts,
      repo: tick.repo,
      dispatch: diffDispatch(tick.planned?.dispatch ?? [], desktop.dispatch ?? []),
      contention: diffContention(tick.planned?.held ?? [], desktop.held ?? []),
      ownership: diffOwnership(tick.othersCounts, tick.unownedCounts, desktop.held ?? []),
    });
  }

  const unmatchedDesktop = desktopEvents
    .map((event, idx) => ({ event, idx }))
    .filter(({ idx }) => !usedDesktopIndexes.has(idx))
    .map(({ event }) => ({ ts: event.ts, repo: event.repo }));

  return { pairs, unmatchedCockpit, unmatchedDesktop };
}
