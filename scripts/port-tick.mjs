#!/usr/bin/env node
// The tick engine's CLI entry: arg parse, subcommand dispatch, JSON to
// stdout, exit codes. This file only wires — every decision is imported from
// scripts/port-tick/, following the runner-plus-modules split
// scripts/checks.mjs already establishes (docs/ENGINEERING.md §1).
//
// Four subcommands, each emitting one JSON object on stdout and nothing
// else. Exit 0 on a usable result, 1 on a hard failure, 2 on a blind tick —
// the model reads the JSON either way, never the exit code alone.
//
//   start                                   resolve config + labels, write both
//                                            state files fresh
//   plan                                    one GraphQL call → the tick plan
//                                            (never persists)
//   commit --tick <id> --live <d> --dispatched <d>
//                                            liveness diff + pacing → both
//                                            state files
//   resolve --item <n> --decision <d>       the `writes` for a human gate answer
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, resolveExcusedCheckName } from './port-tick/config.mjs';
import { buildQuery } from './port-tick/query.mjs';
import { runGraphql } from './port-tick/gh.mjs';
import { classifyEnvelope, truncatedAliases } from './port-tick/envelope.mjs';
import { partitionOwnership, issueSessionRequiredReason, prSessionRequiredReason } from './port-tick/classify.mjs';
import { rollupVerdict } from './port-tick/checks.mjs';
import { mergeabilityRoute, refreshDecision, capRefreshes, zeroDiffGate, cycleCapExceeded, approvedReverify } from './port-tick/gates.mjs';
import { parseFilesBlock, gateCandidates } from './port-tick/contention.mjs';
import { classifyUnmatched, descriptionOf, RETRY_TRIGGER, isUsageLimitMessage } from './port-tick/liveness.mjs';
import { nextDelay } from './port-tick/pacing.mjs';
import { readState, writeState, freshTickState, freshDispatchLog, TICK_STATE_PATH, DISPATCH_LOG_PATH } from './port-tick/state.mjs';

const TICK_PLAN_CACHE_PATH = '.temp/tick-plan.json'; // ephemeral bridge, never durable ladder/dispatch-log state

function emit(obj, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  process.exitCode = exitCode;
}

function die(message, exitCode = 1) {
  emit({ ok: false, error: message }, exitCode);
}

function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

// --- start --------------------------------------------------------------
function cmdStart(root, cfg) {
  writeState(root, TICK_STATE_PATH, freshTickState(cfg.repo));
  writeState(root, DISPATCH_LOG_PATH, freshDispatchLog(cfg.repo));
  emit({ ok: true, repo: cfg.repo, labels: cfg.labels, integration: cfg.integration });
}

// --- plan -----------------------------------------------------------------
function cmdPlan(root, cfg) {
  const tickState = readState(root, TICK_STATE_PATH, cfg.repo) ?? freshTickState(cfg.repo);
  const dispatchLog = readState(root, DISPATCH_LOG_PATH, cfg.repo) ?? freshDispatchLog(cfg.repo);

  const query = buildQuery({
    owner: cfg.owner,
    name: cfg.name,
    labels: cfg.labels,
    modules: cfg.modules,
    announcedApproved: tickState.announcedApproved ?? [],
  });
  const res = runGraphql(query);
  const clock = res.headers?.date ?? null;

  if (!res.ok) {
    return emit({ ok: false, tickId: null, clock, envelope: { kind: 'blind' }, error: res.error ?? 'gh api graphql failed', dispatch: [], writes: [], gates: [], held: [], announce: [], artifacts: [] }, 2);
  }

  const envelope = classifyEnvelope(res.body);
  if (envelope.kind === 'blind') {
    return emit({ ok: true, tickId: `blind-${Date.now()}`, clock, envelope, dispatch: [], writes: [], gates: [], held: [], announce: [], artifacts: [], wakeup: 270 }, 2);
  }

  const repository = res.body.data.repository;
  const truncated = truncatedAliases(repository);
  const viewer = res.body.data.viewer?.login ?? null;

  const dispatch = [];
  const gates = [];
  const held = [];
  const announce = [];
  const writes = [];

  // --- Ownership partition, every trigger/gate/in-flight alias --------------
  const partitions = {};
  const aliasSpecs = [
    ['ready', 'planAgent'], ['planChangesRequested', 'planAgent'], ['planApproved', 'implAgent'],
    ['readyForReview', 'reviewAgent'], ['needsRevision', 'reviseAgent'], ['refreshBranch', 'reviseAgent'],
    ['planReview', null], ['blocked', null], ['approved', null], ['needsHuman', null],
    ['planning', null], ['inProgress', null], ['reviewing', null], ['revising', null], ['refreshing', null],
    ['prOpened', null],
  ];
  for (const [alias] of aliasSpecs) {
    const set = repository[alias];
    partitions[alias] = set ? partitionOwnership(set.nodes, viewer) : { mine: [], others: [], unowned: [] };
  }

  // --- Session-required filtering + dispatch: plan/impl/revise triggers ----
  for (const item of partitions.ready.mine) dispatch.push({ stage: 'plan-agent', item: item.number, kind: 'plan', model: cfg.models.plan, reason: 'ready' });
  for (const item of partitions.planChangesRequested.mine) dispatch.push({ stage: 'plan-agent', item: item.number, kind: 'plan-revision', model: cfg.models.plan, reason: 'plan changes requested' });

  // planApproved: session-required check, then file contention gate
  const inFlightClaims = [];
  for (const item of partitions.inProgress.mine) {
    inFlightClaims.push({ item: item.number, label: 'in progress', paths: parseFilesBlock(item.body) ?? [] });
  }
  for (const item of partitions.prOpened.mine) {
    inFlightClaims.push({ item: item.number, label: 'pr opened', paths: parseFilesBlock(item.body) ?? [] });
  }

  const structuredCandidates = [];
  for (const item of partitions.planApproved.mine) {
    const reason = issueSessionRequiredReason(item.body);
    if (reason) {
      announce.push({ kind: 'session-required-issue', item: item.number, facts: { reason } });
      continue;
    }
    const paths = parseFilesBlock(item.body);
    if (paths === null) {
      dispatch.push({ stage: 'impl-agent', item: item.number, kind: 'impl', model: cfg.models.impl, reason: 'unstructured plan — dispatched unchecked' });
      continue;
    }
    structuredCandidates.push({ item: item.number, paths });
  }
  const gated = gateCandidates(structuredCandidates, inFlightClaims, cfg.concurrency.sharedFiles, cfg.concurrency.overlapThreshold);
  for (const n of gated.dispatch) dispatch.push({ stage: 'impl-agent', item: n, kind: 'impl', model: cfg.models.impl, reason: 'plan approved' });
  for (const h of gated.held) held.push(h);

  // refreshBranch trigger: always revise-agent in refresh mode
  for (const item of partitions.refreshBranch.mine) {
    dispatch.push({ stage: 'revise-agent', item: item.number, kind: 'refresh', model: cfg.models.revise, reason: 'refresh branch' });
  }

  // --- Refresh sweep state: readyForReview ∪ approved reading CONFLICTING ---
  // Collected here and resolved together below via gates.mjs's
  // mergeabilityRoute/refreshDecision/capRefreshes — an automatic rebase +
  // force-push, never a human gate. `refreshedUpdates`/`unknownStreakUpdates`
  // are applied to tickState by `commit`, since `plan` itself never persists.
  const refreshedState = tickState.refreshed ?? {};
  const unknownStreakState = tickState.unknownStreak ?? {};
  const refreshedUpdates = [];
  const unknownStreakUpdates = [];
  const refreshCandidates = [];

  // readyForReview: mergeability routing, zero-diff gate, then dispatch
  for (const item of partitions.readyForReview.mine) {
    if (item.mergeable === 'CONFLICTING') {
      refreshCandidates.push({ number: item.number, headRefOid: item.headRefOid, wasApproved: false });
      continue;
    }

    if (item.mergeable === 'UNKNOWN') {
      const route = mergeabilityRoute('UNKNOWN', unknownStreakState[item.number] ?? 0);
      if (route.action === 'hold') {
        announce.push({ kind: 'mergeability-unknown', item: item.number, facts: {} });
        unknownStreakUpdates.push({ item: item.number, streak: route.unknownStreak });
        continue;
      }
      unknownStreakUpdates.push({ item: item.number, remove: true });
    } else if (unknownStreakState[item.number] != null) {
      unknownStreakUpdates.push({ item: item.number, remove: true });
    }

    const zd = zeroDiffGate({ reviews: item.reviews?.nodes, comments: item.comments?.nodes, headRefOid: item.headRefOid });
    if (zd.action === 'escalate') {
      writes.push({
        command: `gh pr edit ${item.number} --repo ${cfg.repo} --remove-label "${cfg.labels.readyForReview}" --add-label "${cfg.labels.needsHuman}"`,
        why: 'zero-diff review gate',
      });
      announce.push({ kind: 'zero-diff', item: item.number, facts: {} });
      continue;
    }
    dispatch.push({ stage: 'review-agent', item: item.number, kind: 'review', model: cfg.models.review, reason: 'ready for review' });
  }

  // needsRevision: session-required + cycle cap
  for (const item of partitions.needsRevision.mine) {
    const reason = prSessionRequiredReason(item.body);
    if (reason) {
      announce.push({ kind: 'session-required-pr', item: item.number, facts: { reason } });
      continue;
    }
    if (cycleCapExceeded(item.reviews?.nodes, cfg.reviewCycleCap)) {
      writes.push({
        command: `gh pr edit ${item.number} --repo ${cfg.repo} --remove-label "${cfg.labels.needsRevision}" --add-label "${cfg.labels.needsHuman}"`,
        why: 'cycle cap reached',
      });
      announce.push({ kind: 'cycle-cap', item: item.number, facts: { cap: cfg.reviewCycleCap } });
      continue;
    }
    dispatch.push({ stage: 'revise-agent', item: item.number, kind: 'revise', model: cfg.models.revise, reason: 'needs revision' });
  }

  // approved: re-verify against the two authorising facts
  const excusedCheckName = resolveExcusedCheckName(root, cfg.modules);
  for (const item of partitions.approved.mine) {
    const rollup = item.commits?.nodes?.[0]?.commit?.statusCheckRollup;
    const verdict = rollupVerdict(rollup, excusedCheckName);
    const result = approvedReverify({ verdict, mergeable: item.mergeable });
    if (result.action === 'withdraw') {
      writes.push({
        command: `gh pr edit ${item.number} --repo ${cfg.repo} --remove-label "${cfg.labels.approved}" --add-label "${cfg.labels.needsRevision}"`,
        why: 'approval withdrawn: red check',
      });
      announce.push({ kind: 'approval-withdrawn', item: item.number, facts: { red: result.red } });
    } else if (result.action === 'refresh-in-place') {
      refreshCandidates.push({ number: item.number, headRefOid: item.headRefOid, wasApproved: true });
    } else if (result.action === 'announce-ready') {
      announce.push({ kind: 'approved-ready', item: item.number, facts: { green: result.green } });
    }
  }

  // Bound to 5 per tick, oldest first — deferred candidates stay CONFLICTING
  // and are reconsidered next tick with no state lost meanwhile.
  const { toRefresh, deferred } = capRefreshes(refreshCandidates, 5);
  for (const c of deferred) {
    announce.push({ kind: 'refresh-deferred', item: c.number, facts: {} });
  }
  for (const c of toRefresh) {
    const decision = refreshDecision(refreshedState[c.number], c.headRefOid);
    if (decision.action === 'escalate') {
      const removePart = c.wasApproved ? ` --remove-label "${cfg.labels.approved}"` : '';
      writes.push({
        command: `gh pr edit ${c.number} --repo ${cfg.repo}${removePart} --add-label "${cfg.labels.needsHuman}"`,
        why: `refresh sweep: ${decision.reason}`,
      });
      announce.push({ kind: 'refresh-stuck', item: c.number, facts: { reason: decision.reason, headRefOid: c.headRefOid } });
      refreshedUpdates.push({ item: c.number, remove: true });
      continue;
    }
    writes.push({
      command: `gh pr edit ${c.number} --repo ${cfg.repo} --add-label "${cfg.labels.refreshBranch}"`,
      why: 'refresh sweep: rebase + force-push, no code changes',
    });
    dispatch.push({ stage: 'revise-agent', item: c.number, kind: 'refresh', model: cfg.models.revise, reason: 'refresh sweep' });
    announce.push({ kind: 'rebase-required', item: c.number, facts: { headRefOid: c.headRefOid, base: cfg.integration, approvalStands: c.wasApproved } });
    refreshedUpdates.push({ item: c.number, sha: c.headRefOid, count: decision.count });
  }

  // plan review / blocked / needs-human — the only three partitions the
  // engine had computed and then silently never surfaced (R1-C1). Only
  // plan-review and needs-human are real human gates (resolve --decision
  // already has both pairs of decisions); blocked resolves by relaying the
  // issue's own blocker comment and resuming the *same* dispatched agent via
  // SendMessage — a conversation the tick engine has no handle for, so it is
  // report-only here rather than a fabricated resolve path.
  for (const item of partitions.planReview.mine) {
    gates.push({ kind: 'plan-review', item: item.number, facts: {} });
  }
  for (const item of partitions.needsHuman.mine) {
    gates.push({ kind: 'needs-human', item: item.number, facts: {} });
  }
  for (const item of partitions.blocked.mine) {
    announce.push({ kind: 'blocked', item: item.number, facts: {} });
  }

  const items = {
    mine: Object.fromEntries(aliasSpecs.map(([a]) => [a, partitions[a].mine.map((n) => n.number)])),
    others: Object.fromEntries(aliasSpecs.map(([a]) => [a, partitions[a].others.map((n) => n.number)])),
    unowned: Object.fromEntries(aliasSpecs.map(([a]) => [a, partitions[a].unowned.map((n) => n.number)])),
  };

  const tickId = `${clock ?? Date.now()}`;
  const willMoveWithoutHuman = dispatch.length > 0 || partitions.planning.mine.length + partitions.inProgress.mine.length + partitions.reviewing.mine.length + partitions.revising.mine.length + partitions.refreshing.mine.length > 0;
  const wakeup = willMoveWithoutHuman ? 270 : nextDelay(tickState.cadenceStep ?? 0, { willMoveWithoutHuman: false, observedChange: false }).delay;

  const plan = {
    ok: true,
    tickId,
    clock,
    envelope: { ...envelope, truncated },
    items,
    dispatch,
    gates,
    held,
    announce,
    writes,
    artifacts: [],
    // `label` is resolved through `cfg.labels`, never the default string
    // literal — a repository that overrides e.g. `labels.inProgress` must
    // still match here, since `commit`'s liveness reset writes `--remove-label
    // "${expected.label}"` verbatim.
    livenessExpected: [
      ...partitions.planning.mine.map((n) => ({ item: n.number, labelKey: 'planning', label: cfg.labels.planning, stage: 'plan-agent' })),
      ...partitions.inProgress.mine.map((n) => ({ item: n.number, labelKey: 'inProgress', label: cfg.labels.inProgress, stage: 'impl-agent' })),
      ...partitions.reviewing.mine.map((n) => ({ item: n.number, labelKey: 'reviewing', label: cfg.labels.reviewing, stage: 'review-agent' })),
      ...partitions.revising.mine.map((n) => ({ item: n.number, labelKey: 'revising', label: cfg.labels.revising, stage: 'revise-agent' })),
      ...partitions.refreshing.mine.map((n) => ({ item: n.number, labelKey: 'refreshing', label: cfg.labels.refreshing, stage: 'revise-agent' })),
    ],
    refreshedUpdates,
    unknownStreakUpdates,
    wakeup,
    rateLimit: res.body.data.rateLimit ?? null,
  };

  writeState(root, TICK_PLAN_CACHE_PATH, { repo: cfg.repo, ...plan, dispatchLog });
  emit(plan, 0);
}

// --- commit -----------------------------------------------------------------
function cmdCommit(root, cfg, args) {
  const tickId = args.tick;
  if (!tickId) return die("commit requires --tick <id>");
  const cachePath = join(root, TICK_PLAN_CACHE_PATH);
  if (!existsSync(cachePath)) return die('no cached plan found — commit must follow a plan call this same tick', 1);
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  if (cache.repo !== cfg.repo || cache.tickId !== tickId) {
    return die(`--tick '${tickId}' does not match the plan this session last ran ('${cache.tickId ?? 'none'}') — the model must run the script's own plan this tick before committing`, 1);
  }

  const liveDescriptions = (args.live ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const dispatchedItems = (args.dispatched ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  const tickState = readState(root, TICK_STATE_PATH, cfg.repo) ?? freshTickState(cfg.repo);
  const dispatchLog = readState(root, DISPATCH_LOG_PATH, cfg.repo) ?? freshDispatchLog(cfg.repo);

  // Record every fresh dispatch this tick.
  for (const spec of cache.dispatch ?? []) {
    if (dispatchedItems.includes(String(spec.item))) {
      dispatchLog.items[spec.item] = { stage: spec.stage, state: 'dispatched', resets: dispatchLog.items[spec.item]?.resets ?? 0 };
    }
  }

  // Liveness diff for every in-flight item the plan expected.
  const writes = [];
  const resets = [];
  for (const expected of cache.livenessExpected ?? []) {
    const description = descriptionOf(expected.stage.replace('-agent', ''), expected.item);
    if (liveDescriptions.includes(description)) continue; // matched, running
    const row = dispatchLog.items[expected.item];
    const result = classifyUnmatched(row);
    if (result.class === 'reset') {
      dispatchLog.items[expected.item] = { stage: row.stage, state: 'reset', resets: result.nextResets };
      // Resolved from the labelKey the plan recorded, never by matching the
      // resolved name back against cfg.labels — a repository overriding a
      // label name must still hit the right trigger.
      const trigger = RETRY_TRIGGER[expected.labelKey] ?? null;
      resets.push({ item: expected.item, from: expected.label, toKey: trigger });
    } else if (result.class === 'suspect') {
      dispatchLog.items[expected.item] = { stage: row?.stage ?? expected.stage, state: 'suspect', resets: result.nextResets };
    }
    // 'no-record' and 'capped' — report-only, no state change.
  }

  for (const r of resets) {
    if (!r.toKey) continue;
    const triggerName = cfg.labels[r.toKey];
    writes.push({
      command: `gh issue edit ${r.item} --repo ${cfg.repo} --remove-label "${r.from}" --add-label "${triggerName}"`,
      why: `liveness reset: ${r.from} → ${triggerName}`,
    });
  }

  // Apply the refresh sweep's and the mergeability-UNKNOWN carve-out's
  // per-item state — `plan` only computed these, since it never persists.
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

  writeState(root, TICK_STATE_PATH, tickState);
  writeState(root, DISPATCH_LOG_PATH, dispatchLog);

  emit({ ok: true, tickId, writes, resets, wakeup: pacing.delay });
}

// --- resolve ------------------------------------------------------------
function cmdResolve(root, cfg, args) {
  const item = args.item;
  const decision = args.decision;
  if (!item || !decision) return die('resolve requires --item <n> --decision <approve|changes|back-to-revision|back-to-review>');

  const writes = [];
  if (decision === 'approve') {
    writes.push({ command: `gh issue edit ${item} --repo ${cfg.repo} --remove-label "${cfg.labels.planReview}" --add-label "${cfg.labels.planApproved}"`, why: 'plan review: approved' });
  } else if (decision === 'changes') {
    writes.push({ command: `gh issue edit ${item} --repo ${cfg.repo} --remove-label "${cfg.labels.planReview}" --add-label "${cfg.labels.planChangesRequested}"`, why: 'plan review: changes requested' });
  } else if (decision === 'back-to-revision') {
    writes.push({ command: `gh pr edit ${item} --repo ${cfg.repo} --remove-label "${cfg.labels.needsHuman}" --add-label "${cfg.labels.needsRevision}"`, why: 'gate cleared: back to revision' });
  } else if (decision === 'back-to-review') {
    writes.push({ command: `gh pr edit ${item} --repo ${cfg.repo} --remove-label "${cfg.labels.needsHuman}" --add-label "${cfg.labels.readyForReview}"`, why: 'gate cleared: back to review' });
  } else {
    return die(`unrecognized --decision '${decision}'`);
  }
  emit({ ok: true, item, decision, writes });
}

// --- CLI --------------------------------------------------------------------
function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1];
  }
  return out;
}

function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  const root = repoRoot();
  let cfg;
  try {
    cfg = loadConfig(root);
  } catch (e) {
    return die(e.message);
  }

  const args = parseFlags(rest);
  if (subcommand === 'start') return cmdStart(root, cfg);
  if (subcommand === 'plan') return cmdPlan(root, cfg);
  if (subcommand === 'commit') return cmdCommit(root, cfg, args);
  if (subcommand === 'resolve') return cmdResolve(root, cfg, args);
  return die(`unrecognized subcommand '${subcommand ?? ''}'. usage: node port-tick.mjs <start|plan|commit|resolve> [flags]`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
