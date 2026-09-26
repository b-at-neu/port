// The trajectory record's reader — `node scripts/port-tick.ts report`.
// Read-only, local-only: no `gh` call, and nothing under scripts/port-tick/
// other than this file may read `.agents/events.jsonl` — `events.ts`
// deliberately exports no reader (docs/ENGINEERING.md §1's write-only rail).
// Never in `commands.checks`: it reads a gitignored path absent from a
// dispatched agent's worktree and from CI (docs/ENGINEERING.md §6).
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EVENTS_PATH, EVENTS_PREV_PATH } from './events.ts';

const RESOLUTION_SECONDS = 270;
const DENIAL_LOG_WARN_BYTES = 4 * 1024 * 1024;
const DEFAULT_GAP_GRACE_SECONDS = 300;
const ESCALATION_KINDS = new Set(['cycle-cap', 'zero-diff', 'refresh-stuck', 'approval-withdrawn', 'blocked']);

/** Reads both generations, oldest first, tolerating either being absent or
 *  unreadable. Never throws — a missing file means "nothing recorded",
 *  never an error. */
export function readEventLines(root: string): string[] {
  const lines: string[] = [];
  for (const rel of [EVENTS_PREV_PATH, EVENTS_PATH]) {
    const path = join(root, rel);
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line !== '') lines.push(line);
    }
  }
  return lines;
}

/** Pure: parses raw JSONL lines into events. A line that does not parse, or
 *  whose `v` is not the recognized version, is skipped and counted in
 *  `skipped` rather than crashing the reader or being silently dropped
 *  (docs/ENGINEERING.md §4 — forward-compatible, loudly: every count above
 *  it in the report is then a lower bound). */
export function parseEventLines(lines: string[]): { events: any[]; skipped: { malformed: number; unknownVersion: number } } {
  const events: any[] = [];
  let malformed = 0;
  let unknownVersion = 0;
  for (const line of lines) {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (obj == null || typeof obj !== 'object' || obj.v !== 1) {
      unknownVersion += 1;
      continue;
    }
    events.push(obj);
  }
  return { events, skipped: { malformed, unknownVersion } };
}

/** Pure: dormancy detection over chronologically sorted `tick` events. A gap
 *  is reported when the actual interval between two consecutive ticks
 *  exceeds the earlier tick's own proposed wakeup by more than
 *  `graceSeconds` — the same "materially overshoots what was scheduled"
 *  test `SKILL.md`'s own resume line uses, applied after the fact instead of
 *  live. */
export function findGaps(tickEvents: any[], graceSeconds = DEFAULT_GAP_GRACE_SECONDS): any[] {
  const gaps: any[] = [];
  for (let i = 1; i < tickEvents.length; i++) {
    const prev = tickEvents[i - 1];
    const cur = tickEvents[i];
    const prevMs = Date.parse(prev.ts);
    const curMs = Date.parse(cur.ts);
    if (Number.isNaN(prevMs) || Number.isNaN(curMs)) continue;
    const actualSeconds = (curMs - prevMs) / 1000;
    const scheduledSeconds = typeof prev.wakeupProposed === 'number' ? prev.wakeupProposed : RESOLUTION_SECONDS;
    if (actualSeconds - scheduledSeconds > graceSeconds) {
      gaps.push({ from: prev.ts, to: cur.ts, durationSeconds: Math.round(actualSeconds), scheduledSeconds });
    }
  }
  return gaps;
}

/** Pure: reconstructs each dispatch's span from the tick stream alone —
 *  no per-dispatch timer exists locally (that precision lives behind
 *  `commands.budget`, #188's ledger, which this ticket does not duplicate,
 *  per docs/ENGINEERING.md §2). Pairs a `tick-commit`'s `dispatched` entry
 *  with the first later tick where the item is absent from that tick's own
 *  `liveItems` — the span's end is only ever known to tick resolution
 *  (`RESOLUTION_SECONDS`), never exact, and `seconds` is `null` (ongoing)
 *  when no later tick ever drops the item. */
export function deriveSpans(events: any[]): any[] {
  const ticks = [...events].filter((e) => e.kind === 'tick').sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const commits = events.filter((e) => e.kind === 'tick-commit');
  const commitByTick = new Map(commits.map((c) => [c.tickId, c]));

  const spans: any[] = [];
  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i];
    const commit = commitByTick.get(tick.tickId);
    if (!commit) continue;
    for (const item of commit.dispatched ?? []) {
      const spec = (tick.planned?.dispatch ?? []).find((d: any) => String(d.item) === String(item));
      const stage = spec?.stage ?? 'unknown';
      const model = spec?.model ?? null;
      let endTs: string | null = null;
      for (let j = i + 1; j < ticks.length; j++) {
        const stillLive = (ticks[j].liveItems ?? []).some((li: any) => String(li.item) === String(item));
        if (!stillLive) {
          endTs = ticks[j].ts;
          break;
        }
      }
      const startTs = commit.ts ?? tick.ts;
      const startMs = Date.parse(startTs);
      const endMs = endTs ? Date.parse(endTs) : NaN;
      const seconds = endTs && !Number.isNaN(startMs) && !Number.isNaN(endMs) ? Math.max(0, Math.round((endMs - startMs) / 1000)) : null;
      spans.push({ item, stage, model, startTs, endTs, seconds, resolutionSeconds: RESOLUTION_SECONDS, ongoing: endTs == null });
    }
  }
  return spans;
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mode(values: any[]): any {
  if (!values.length) return null;
  const counts = new Map<any, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** Pure: the whole reduction, from a (possibly `--since`/`--run`-filtered)
 *  event list to the report's JSON shape (`text` excluded — `renderText`
 *  composes that separately, since it also needs `skipped`/denial-log-size
 *  facts that are not events). An absent signal is never `0`: `window.runs`
 *  is flagged `runsIsLowerBound` whenever a `runId` appears on a tick with
 *  no matching `run-start` — a session that skipped `start` inherits the
 *  previous run's id, so the true run count can only be undercounted, never
 *  overcounted. */
export function aggregate(events: any[]): any {
  const ticks = events.filter((e) => e.kind === 'tick').sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const commits = events.filter((e) => e.kind === 'tick-commit');
  const runStartIds = new Set(events.filter((e) => e.kind === 'run-start').map((r) => r.runId));
  const commitByTick = new Map(commits.map((c) => [c.tickId, c]));

  const allTs = events.map((e) => Date.parse(e.ts)).filter((n) => !Number.isNaN(n));
  const from = allTs.length ? new Date(Math.min(...allTs)).toISOString() : null;
  const to = allTs.length ? new Date(Math.max(...allTs)).toISOString() : null;

  const runIds = new Set(events.map((e) => e.runId).filter((r) => r != null));
  let runsIsLowerBound = false;
  for (const r of runIds) if (!runStartIds.has(r)) runsIsLowerBound = true;

  let blind = 0;
  let partial = 0;
  let incomplete = 0;
  for (const t of ticks) {
    if (t.envelope?.kind === 'blind') {
      blind += 1;
      continue;
    }
    if (t.envelope?.kind === 'partial') partial += 1;
    if (!commitByTick.has(t.tickId)) incomplete += 1;
  }

  let taskListRan = 0;
  let taskListMissing = 0;
  for (const c of commits) {
    if (c.taskList === 'run') taskListRan += 1;
    else if (c.taskList === 'not-run') taskListMissing += 1;
  }

  const gaps = findGaps(ticks);
  const tickGapSeconds: number[] = [];
  for (let i = 1; i < ticks.length; i++) {
    const prevMs = Date.parse(ticks[i - 1].ts);
    const curMs = Date.parse(ticks[i].ts);
    if (!Number.isNaN(prevMs) && !Number.isNaN(curMs)) tickGapSeconds.push((curMs - prevMs) / 1000);
  }
  const medianGapSeconds = median(tickGapSeconds);

  const allDispatch: any[] = ticks.flatMap((t) => t.planned?.dispatch ?? []);
  const byStage: Record<string, number> = {};
  for (const d of allDispatch) byStage[d.stage] = (byStage[d.stage] ?? 0) + 1;

  const spans = deriveSpans(events);
  const resolved = spans.filter((s) => s.seconds != null);
  const stageSeconds: Record<string, number[]> = {};
  const stageModels: Record<string, any[]> = {};
  for (const s of resolved) {
    (stageSeconds[s.stage] ??= []).push(s.seconds);
    if (s.model) (stageModels[s.stage] ??= []).push(s.model);
  }
  const byStageMedianSeconds: Record<string, number> = {};
  const byStageModel: Record<string, any> = {};
  for (const stage of Object.keys(stageSeconds)) {
    byStageMedianSeconds[stage] = Math.round(median(stageSeconds[stage]) ?? 0);
    byStageModel[stage] = mode(stageModels[stage] ?? []);
  }
  const totalDispatch: number = Object.values(byStage).reduce((a, b) => a + b, 0);
  const coverage = totalDispatch > 0 ? resolved.length / totalDispatch : null;

  const itemsMap = new Map<any, any>();
  const touch = (item: any): any => {
    if (!itemsMap.has(item)) itemsMap.set(item, { item, dispatches: 0, byStage: {}, reviewCycles: 0, escalations: 0 });
    return itemsMap.get(item);
  };
  for (const d of allDispatch) {
    const row = touch(d.item);
    row.dispatches += 1;
    row.byStage[d.stage] = (row.byStage[d.stage] ?? 0) + 1;
    if (d.stage === 'review-agent') row.reviewCycles += 1;
  }

  const escalations: any[] = [];
  for (const t of ticks) {
    for (const a of t.planned?.announce ?? []) {
      if (ESCALATION_KINDS.has(a.kind)) {
        escalations.push({ item: a.item, kind: a.kind, ts: t.ts });
        touch(a.item).escalations += 1;
      }
    }
  }

  const holdRows = new Map<string, any>();
  for (const t of ticks) {
    for (const h of t.planned?.held ?? []) {
      const key = `${h.item} ${h.blocker}`;
      const row = holdRows.get(key) ?? { item: h.item, blocker: h.blocker, depth: h.depth, ticks: 0, contendedPaths: new Set() };
      row.ticks += 1;
      row.depth = h.depth ?? row.depth;
      for (const p of h.contendedPaths ?? []) row.contendedPaths.add(p);
      holdRows.set(key, row);
    }
  }

  const denials: Record<string, number> = { deny: 0, railDeny: 0, miss: 0, gateClear: 0, hookError: 0, unknown: 0, malformed: 0, newLines: 0 };
  for (const t of ticks) {
    if (!t.denials) continue;
    for (const key of Object.keys(denials)) denials[key] += t.denials[key] ?? 0;
  }

  return {
    window: { from, to, runs: runIds.size, runsIsLowerBound },
    ticks: { planned: ticks.length, committed: commits.length, incomplete, blind, partial, taskListRan, taskListMissing },
    cadence: { medianGapSeconds, gaps },
    dispatches: { total: totalDispatch, byStage, resolutionSeconds: RESOLUTION_SECONDS, coverage, byStageMedianSeconds, byStageModel },
    items: [...itemsMap.values()].sort((a, b) => b.dispatches - a.dispatches),
    denials,
    escalations,
    holds: [...holdRows.values()].map((h) => ({ ...h, contendedPaths: [...h.contendedPaths] })),
  };
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return 'unknown';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

const shortStage = (stage: string): string => stage.replace('-agent', '');
const escalationLabel = (kind: string): string =>
  ({ 'cycle-cap': 'cycle cap', 'zero-diff': 'zero-diff', 'refresh-stuck': 'refresh stuck', 'approval-withdrawn': 'approval withdrawn' } as Record<string, string>)[kind] ?? kind;

/** Pure (given its inputs): the human-readable `text` field. Sections that
 *  do not apply are omitted rather than printed as "0" or "none"
 *  (docs/ENGINEERING.md §4's writing style). */
export function renderText(
  report: any,
  { repo, skipped = { malformed: 0, unknownVersion: 0 }, denialLogBytes = null }: { repo?: string; skipped?: { malformed: number; unknownVersion: number }; denialLogBytes?: number | null } = {},
): string {
  const lines: string[] = [];
  const runsLabel = report.window.runsIsLowerBound ? `≥${report.window.runs}` : `${report.window.runs}`;
  lines.push(`Trajectory record — ${repo} · ${report.window.from ?? 'unknown'} → ${report.window.to ?? 'unknown'} · ${runsLabel} runs`, '');

  const t = report.ticks;
  lines.push(`Ticks        ${t.planned} planned · ${t.committed} committed · ${t.incomplete} started and never committed · ${t.blind} blind · ${t.partial} partial`);
  lines.push(`TaskList     ${t.taskListRan} of ${t.committed} committed ticks ran it · ${t.taskListMissing} did not`);

  const gapPart = report.cadence.medianGapSeconds != null ? `median gap ${Math.round(report.cadence.medianGapSeconds)}s` : 'no cadence data yet';
  const dormancy = report.cadence.gaps.length
    ? ` · ${report.cadence.gaps.length} dormancy: ${report.cadence.gaps.map((g: any) => `${g.from} → ${g.to} (${formatDuration(g.durationSeconds)}, ${g.scheduledSeconds}s scheduled)`).join('; ')}`
    : '';
  lines.push(`Cadence      ${gapPart}${dormancy}`);

  if (report.dispatches.total > 0) {
    const byStage = Object.entries(report.dispatches.byStage).map(([s, n]) => `${shortStage(s)} ${n}`).join(' · ');
    const medians = Object.entries<number>(report.dispatches.byStageMedianSeconds)
      .map(([s, sec]) => `${shortStage(s)} median ~${formatDuration(sec)}${report.dispatches.byStageModel[s] ? ` (${report.dispatches.byStageModel[s]})` : ''}`)
      .join(' · ');
    lines.push(`Dispatch     ${report.dispatches.total} — ${byStage}${medians ? ` · ${medians}` : ''}`);
  }

  const cycleItems = report.items.filter((i: any) => i.reviewCycles > 0).slice(0, 5);
  if (cycleItems.length) {
    const parts = cycleItems.map((i: any, idx: number) => (idx === 0 ? `#${i.item} ${i.reviewCycles} review cycle${i.reviewCycles === 1 ? '' : 's'}` : `#${i.item} ${i.reviewCycles}`));
    lines.push(`Cycles       ${parts.join(' · ')}`);
  }

  const d = report.denials;
  lines.push(`Denials      ${d.deny} deny (${d.railDeny} from the cockpit's own rails) · ${d.miss} miss · ${d.gateClear} gate-clear · ${d.hookError} hook-error`);

  if (report.escalations.length) {
    lines.push(`Escalations  ${report.escalations.length} — ${report.escalations.map((e: any) => `#${e.item} ${escalationLabel(e.kind)}`).join(' · ')}`);
  }
  if (report.holds.length) {
    lines.push(
      `Holds        ${report.holds
        .map((h: any) => `#${h.item} held ${h.ticks} tick${h.ticks === 1 ? '' : 's'}${h.contendedPaths.length ? ` on ${h.contendedPaths.join(', ')}` : ''} (blocker #${h.blocker})`)
        .join(' · ')}`,
    );
  }

  lines.push('', `Durations are derived from tick boundaries (±${report.dispatches.resolutionSeconds}s). Exact per-dispatch seconds live in each`, `issue's "Pipeline Cost" ledger when \`commands.budget\` is set.`);

  if (skipped.malformed || skipped.unknownVersion) {
    const parts: string[] = [];
    if (skipped.malformed) parts.push(`${skipped.malformed} unparseable`);
    if (skipped.unknownVersion) parts.push(`${skipped.unknownVersion} from an unrecognized format version`);
    lines.push(`⚠️ ${skipped.malformed + skipped.unknownVersion} lines skipped (${parts.join(', ')}) — every count above is a lower bound.`);
  }
  if (denialLogBytes != null && denialLogBytes > DENIAL_LOG_WARN_BYTES) {
    lines.push(`⚠️ \`.agents/denials.log\` is ${(denialLogBytes / (1024 * 1024)).toFixed(1)} MB and is not rotated by design — see docs/TESTING.md → "Trajectory record".`);
  }

  return lines.join('\n');
}

/** The `report` subcommand's whole implementation — the only impure entry
 *  point in this module. `args` may carry `since` (ISO string) and `run` (a
 *  `runId`), both filters applied before aggregation. Never throws: an
 *  absent record is reported in `text`, not treated as an error. */
export function runReport(root: string, cfg: any, args: any = {}): any {
  const present = existsSync(join(root, EVENTS_PATH)) || existsSync(join(root, EVENTS_PREV_PATH));
  if (!present) {
    return {
      ok: true,
      present: false,
      text: `No trajectory record for ${cfg.repo}. \`.agents/events.jsonl\` does not exist — that is\n"nothing recorded", not "nothing happened". A cockpit session writes it from its first tick.`,
    };
  }

  const { events: allEvents, skipped } = parseEventLines(readEventLines(root));
  const sinceMs = args.since ? Date.parse(args.since) : null;
  const events = allEvents.filter((e: any) => {
    if (sinceMs != null && !Number.isNaN(sinceMs)) {
      const ts = Date.parse(e.ts);
      if (Number.isNaN(ts) || ts < sinceMs) return false;
    }
    if (args.run && e.runId !== args.run) return false;
    return true;
  });

  const report = aggregate(events);
  let denialLogBytes: number | null = null;
  try {
    denialLogBytes = statSync(join(root, '.agents', 'denials.log')).size;
  } catch {
    denialLogBytes = null;
  }
  const text = renderText(report, { repo: cfg.repo, skipped, denialLogBytes });

  return { ok: true, present: true, ...report, skipped, text };
}
