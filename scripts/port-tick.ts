#!/usr/bin/env node
// CLI entry: arg parse, subcommand dispatch, JSON to stdout. Wiring only — every decision
// lives in scripts/port-tick/. Exit 0 usable, 1 hard failure, 2 blind tick.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig } from './port-tick/config.ts';
import { buildQuery } from './port-tick/query.ts';
import { runGraphql } from './port-tick/gh.ts';
import { classifyEnvelope, truncatedAliases } from './port-tick/envelope.ts';
import { labelsByItem, contradictions, actionablePartitions, reconcileTick, ungatedPullRequests, reportOrphans, ticketsByPullRequest } from './port-tick/reconcile.ts';
import { classifyUnmatched, descriptionOf, RETRY_TRIGGER, isUsageLimitMessage, buildLivenessExpected } from './port-tick/liveness.ts';
import { nextDelay } from './port-tick/pacing.ts';
import { freshAccumulator, partitionAliases, planTriggers, planReadyForReview, planNeedsRevision, planApproved, planRefreshSweep, planHumanGates } from './port-tick/plan.ts';
import { readState, writeState, freshTickState, freshDispatchLog, newRunId, TICK_STATE_PATH, DISPATCH_LOG_PATH } from './port-tick/state.ts';
import { livenessResetWrite, gateResolveWrite } from './port-tick/writes.ts';
import { formatEvent, appendEvent, rotateIfNeeded, envelopeFor, runStartPayload, tickEventPayload } from './port-tick/events.ts';
import { summarizeDelta } from './port-tick/denials.ts';
import { runReport } from './port-tick/report.ts';

const TICK_PLAN_CACHE_PATH = '.temp/tick-plan.json'; // ephemeral bridge, never durable ladder/dispatch-log state

function emit(obj: any, exitCode = 0): void {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  process.exitCode = exitCode;
}

function die(message: string, exitCode = 1): void {
  emit({ ok: false, error: message }, exitCode);
}

function repoRoot(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

// --- start --------------------------------------------------------------
function cmdStart(root: string, cfg: any): void {
  rotateIfNeeded(root);
  const tickState = freshTickState(cfg.repo);
  writeState(root, TICK_STATE_PATH, tickState);
  writeState(root, DISPATCH_LOG_PATH, freshDispatchLog(cfg.repo));
  appendEvent(root, formatEvent(envelopeFor('run-start', tickState.runId, cfg.repo), runStartPayload(cfg)));
  emit({ ok: true, repo: cfg.repo, labels: cfg.labels, integration: cfg.integration, runId: tickState.runId, overrides: cfg.overrides });
}

// --- plan -----------------------------------------------------------------
function cmdPlan(root: string, cfg: any): void {
  const tickState = readState(root, TICK_STATE_PATH, cfg.repo) ?? freshTickState(cfg.repo);
  const dispatchLog = readState(root, DISPATCH_LOG_PATH, cfg.repo) ?? freshDispatchLog(cfg.repo);

  const query = buildQuery({
    owner: cfg.owner,
    name: cfg.name,
    labels: cfg.labels,
    announcedApproved: tickState.announcedApproved ?? [],
  });
  const res = runGraphql(query);
  const clock = res.headers?.date ?? null;

  if (!res.ok) {
    appendEvent(root, formatEvent(envelopeFor('tick', tickState.runId, cfg.repo, clock), tickEventPayload({ tickId: null, envelope: { kind: 'blind', unavailable: [] } })));
    return emit({ ok: false, tickId: null, clock, envelope: { kind: 'blind' }, error: res.error ?? 'gh api graphql failed', dispatch: [], writes: [], gates: [], held: [], announce: [], artifacts: [] }, 2);
  }

  const envelope = classifyEnvelope(res.body);
  if (envelope.kind === 'blind') {
    appendEvent(root, formatEvent(envelopeFor('tick', tickState.runId, cfg.repo, clock), tickEventPayload({ tickId: `blind-${Date.now()}`, envelope })));
    return emit({ ok: true, tickId: `blind-${Date.now()}`, clock, envelope, dispatch: [], writes: [], gates: [], held: [], announce: [], artifacts: [], wakeup: 270 }, 2);
  }

  const repository = res.body.data.repository;
  const truncated = truncatedAliases(repository);
  const viewer = res.body.data.viewer?.login ?? null;

  // --- Ownership partition, every trigger/gate/in-flight alias --------------
  const aliasSpecs: [string, string | null][] = [
    ['ready', 'planAgent'], ['planChangesRequested', 'planAgent'], ['planApproved', 'implAgent'],
    ['readyForReview', 'reviewAgent'], ['needsRevision', 'reviseAgent'], ['refreshBranch', 'reviseAgent'],
    ['planReview', null], ['blocked', null], ['approved', null], ['needsHuman', null],
    ['planning', null], ['inProgress', null], ['reviewing', null], ['revising', null], ['refreshing', null],
    ['prOpened', null],
  ];
  const partitions = partitionAliases(repository, viewer, aliasSpecs);

  // Flags any item holding more than one role-bearing label and excludes it
  // from every action below; `partitions` stays the full picture.
  const roleBearingKeys = aliasSpecs.map(([a]) => a);
  const byItem = labelsByItem(repository, roleBearingKeys);
  const contradictionsList = contradictions(byItem, viewer, cfg.labels);
  const actionable = actionablePartitions(partitions, contradictionsList.map((c) => c.item));

  // readyForReview ∪ approved reading CONFLICTING; applied to tickState by `commit`, since `plan` never persists.
  const refreshedState: Record<string, any> = tickState.refreshed ?? {};
  const unknownStreakState: Record<string, any> = tickState.unknownStreak ?? {};

  // Refresh wins: a pull request already claimed by or mid-refresh is never dispatched to review or revision this tick.
  const refreshBranchNumbers = (repository.refreshBranch?.nodes ?? []).map((n: any) => n.number);
  const refreshingNumbers = (repository.refreshing?.nodes ?? []).map((n: any) => n.number);

  const acc = freshAccumulator();
  planTriggers(cfg, actionable, partitions, acc);
  planReadyForReview(cfg, actionable, refreshBranchNumbers, refreshingNumbers, unknownStreakState, acc);
  planNeedsRevision(cfg, actionable, refreshBranchNumbers, refreshingNumbers, acc);
  planApproved(cfg, actionable, refreshBranchNumbers, refreshingNumbers, acc);
  planRefreshSweep(cfg, refreshedState, acc);
  planHumanGates(actionable, acc);

  const { dispatch, gates, held, announce, writes, refreshedUpdates, unknownStreakUpdates } = acc;

  // Ungated sweep: `allOpenPRs` is unconditional — only the filter and the report stay module-gated.
  const openPRs = repository.allOpenPRs?.nodes ?? [];
  const ungated: number[] = cfg.modules.approvalGate ? ungatedPullRequests(openPRs, cfg.labels) : [];

  // Duplicate-pull-request sweep + reconcile reporting, change-only against `.temp/tick-state.json`'s remembered sets.
  const { reconcile, persist: reconcilePersist } = reconcileTick({
    repository, roleBearingKeys, viewer, labels: cfg.labels, integration: cfg.integration,
    envelopeUnavailable: envelope.unavailable, truncated,
    contradictionsReported: tickState.contradictionsReported ?? [], duplicatesReported: tickState.duplicatesReported ?? [],
  });

  const items = {
    mine: Object.fromEntries(aliasSpecs.map(([a]) => [a, partitions[a].mine.map((n: any) => n.number)])),
    others: Object.fromEntries(aliasSpecs.map(([a]) => [a, partitions[a].others.map((n: any) => n.number)])),
    unowned: Object.fromEntries(aliasSpecs.map(([a]) => [a, partitions[a].unowned.map((n: any) => n.number)])),
  };

  // Denial delta since tickState's own offset — the read stays here; denials.ts only classifies it.
  let denialAll: string[] = [];
  try { denialAll = readFileSync(join(root, '.agents', 'denials.log'), 'utf8').split('\n'); } catch {}
  if (denialAll.at(-1) === '') denialAll.pop();
  const denialsDelta = summarizeDelta(denialAll.slice(tickState.denialsConsumed ?? 0));

  const tickId = `${clock ?? Date.now()}`;
  const willMoveWithoutHuman = dispatch.length > 0 || partitions.planning.mine.length + partitions.inProgress.mine.length + partitions.reviewing.mine.length + partitions.revising.mine.length + partitions.refreshing.mine.length > 0;
  const wakeup = willMoveWithoutHuman ? 270 : nextDelay(tickState.cadenceStep ?? 0, { willMoveWithoutHuman: false, observedChange: false }).delay;

  const plan = {
    ok: true,
    tickId,
    clock,
    envelope: { ...envelope, truncated },
    items,
    ungated,
    tickets: ticketsByPullRequest(openPRs, cfg.integration),
    reconcile,
    dispatch,
    gates,
    held,
    announce,
    writes,
    artifacts: [],
    livenessExpected: buildLivenessExpected(actionable, cfg.labels),
    refreshedUpdates,
    unknownStreakUpdates,
    wakeup,
    rateLimit: res.body.data.rateLimit ?? null,
    denials: denialsDelta,
    denialsConsumedAfter: (tickState.denialsConsumed ?? 0) + denialsDelta.newLines,
  };

  appendEvent(root, formatEvent(envelopeFor('tick', tickState.runId, cfg.repo, clock), tickEventPayload({ tickId, envelope: plan.envelope, items, livenessExpected: plan.livenessExpected, dispatch, gates, held, announce, writes, wakeup, rateLimit: plan.rateLimit, denials: denialsDelta })));

  writeState(root, TICK_PLAN_CACHE_PATH, { repo: cfg.repo, ...plan, dispatchLog, reconcilePersist });
  emit(plan, 0);
}

// --- commit -----------------------------------------------------------------
function cmdCommit(root: string, cfg: any, args: any): void {
  const tickId = args.tick;
  if (!tickId) return die("commit requires --tick <id>");
  const cachePath = join(root, TICK_PLAN_CACHE_PATH);
  if (!existsSync(cachePath)) return die('no cached plan found — commit must follow a plan call this same tick', 1);
  const cache: any = JSON.parse(readFileSync(cachePath, 'utf8'));
  if (cache.repo !== cfg.repo || cache.tickId !== tickId) {
    return die(`--tick '${tickId}' does not match the plan this session last ran ('${cache.tickId ?? 'none'}') — the model must run the script's own plan this tick before committing`, 1);
  }

  // `--live`'s presence is the fact, never its value — `""` counts as present, a missing flag does not.
  const liveFlagPresent = args.live !== undefined && !String(args.live).startsWith('--');
  const liveDescriptions = (liveFlagPresent ? args.live : '').split(',').map((s: string) => s.trim()).filter(Boolean);
  const dispatchedItems = (args.dispatched ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);

  const tickState = readState(root, TICK_STATE_PATH, cfg.repo) ?? freshTickState(cfg.repo);
  const dispatchLog = readState(root, DISPATCH_LOG_PATH, cfg.repo) ?? freshDispatchLog(cfg.repo);

  // Record every fresh dispatch this tick.
  for (const spec of cache.dispatch ?? []) {
    if (dispatchedItems.includes(String(spec.item))) {
      dispatchLog.items[spec.item] = { stage: spec.stage, state: 'dispatched', resets: dispatchLog.items[spec.item]?.resets ?? 0 };
    }
  }

  // Liveness diff for every in-flight item the plan expected; `liveness` names every unmatched item's classification.
  const writes: any[] = [];
  const resets: any[] = [];
  const liveness: any[] = [];
  for (const expected of cache.livenessExpected ?? []) {
    const description = descriptionOf(expected.stage.replace('-agent', ''), expected.item);
    if (liveDescriptions.includes(description)) continue; // matched, running
    const row = dispatchLog.items[expected.item];
    const result = classifyUnmatched(row);
    liveness.push({ item: expected.item, class: result.class });
    if (result.class === 'reset') {
      dispatchLog.items[expected.item] = { stage: row.stage, state: 'reset', resets: result.nextResets };
      // Resolved from the labelKey the plan recorded, so a renamed label still hits the right trigger.
      const trigger = (RETRY_TRIGGER as Record<string, string>)[expected.labelKey] ?? null;
      resets.push({ item: expected.item, from: expected.label, fromKey: expected.labelKey, toKey: trigger });
    } else if (result.class === 'suspect') {
      dispatchLog.items[expected.item] = { stage: row?.stage ?? expected.stage, state: 'suspect', resets: result.nextResets };
    }
    // 'no-record' and 'capped' — report-only, no dispatchLog change, but
    // still named in `liveness` above so the model can render them.
  }

  // Change-only against `orphansReported`.
  tickState.orphansReported = reportOrphans(liveness, tickState.orphansReported ?? []);
  tickState.contradictionsReported = cache.reconcilePersist?.contradictions ?? tickState.contradictionsReported ?? [];
  tickState.duplicatesReported = cache.reconcilePersist?.duplicates ?? tickState.duplicatesReported ?? [];

  for (const r of resets) {
    if (!r.toKey) continue;
    writes.push(livenessResetWrite({ repo: cfg.repo, labels: cfg.labels, item: r.item, fromKey: r.fromKey, toKey: r.toKey }));
  }

  // `plan` only computed this per-item state, since it never persists.
  tickState.refreshed = tickState.refreshed ?? {};
  for (const u of cache.refreshedUpdates ?? []) {
    if (u.remove) delete tickState.refreshed[u.item];
    else tickState.refreshed[u.item] = { sha: u.sha, count: u.count };
  }
  tickState.unknownStreak = tickState.unknownStreak ?? {};
  for (const u of cache.unknownStreakUpdates ?? []) {
    if (u.remove) delete tickState.unknownStreak[u.item];
    else tickState.unknownStreak[u.item] = u.streak;
  }

  const willMoveWithoutHuman = (cache.dispatch ?? []).length > 0 || liveDescriptions.length > 0;
  const pacing = nextDelay(tickState.cadenceStep ?? 0, { willMoveWithoutHuman, observedChange: resets.length > 0 });

  tickState.lastTick = cache.clock ?? new Date().toISOString();
  tickState.scheduled = pacing.delay;
  tickState.cadenceStep = pacing.cadenceStep;
  tickState.noChangeTicks = pacing.cadenceStep;
  if (!tickState.runId) tickState.runId = newRunId(); // a session that skipped `start` still groups from here on
  tickState.denialsConsumed = cache.denialsConsumedAfter ?? tickState.denialsConsumed ?? 0;

  writeState(root, TICK_STATE_PATH, tickState);
  writeState(root, DISPATCH_LOG_PATH, dispatchLog);

  appendEvent(root, formatEvent(envelopeFor('tick-commit', tickState.runId, cfg.repo, tickState.lastTick), { tickId, taskList: liveFlagPresent ? 'run' : 'not-run', live: liveDescriptions.length, dispatched: dispatchedItems, liveness, resets: resets.length, wakeup: pacing.delay, cadenceStep: pacing.cadenceStep }));

  emit({ ok: true, tickId, writes, resets, liveness, wakeup: pacing.delay });
}

// --- resolve ------------------------------------------------------------
function cmdResolve(root: string, cfg: any, args: any): void {
  const item = args.item;
  const decision = args.decision;
  if (!item || !decision) return die('resolve requires --item <n> --decision <approve|changes|back-to-revision|back-to-review>');

  const write = gateResolveWrite({ repo: cfg.repo, labels: cfg.labels, item, decision, branch: args.branch });
  if (!write) return die(`unrecognized --decision '${decision}', or an invalid --branch`);
  emit({ ok: true, item, decision, writes: [write] });
}

// --- report -------------------------------------------------------------
function cmdReport(root: string, cfg: any, args: any): void {
  emit(runReport(root, cfg, args));
}

// --- CLI --------------------------------------------------------------------
function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1];
  }
  return out;
}

function main(): void {
  const [subcommand, ...rest] = process.argv.slice(2);
  const root = repoRoot();
  let cfg: any;
  try {
    cfg = loadConfig(root);
  } catch (e) {
    return die(e instanceof Error ? e.message : String(e));
  }

  const args = parseFlags(rest);
  if (subcommand === 'start') return cmdStart(root, cfg);
  if (subcommand === 'plan') return cmdPlan(root, cfg);
  if (subcommand === 'commit') return cmdCommit(root, cfg, args);
  if (subcommand === 'resolve') return cmdResolve(root, cfg, args);
  if (subcommand === 'report') return cmdReport(root, cfg, args);
  return die(`unrecognized subcommand '${subcommand ?? ''}'. usage: node port-tick.ts <start|plan|commit|resolve|report> [flags]`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
