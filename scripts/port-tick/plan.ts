// cmdPlan's own named decision steps, split out of port-tick.ts for line
// budget. Pure: never imports events.ts/report.ts, never touches fs.
import { partitionOwnership, issueSessionRequiredReason, prSessionRequiredReason } from './classify.ts';
import { parseFilesBlock, gateCandidates } from './contention.ts';
import { rollupVerdict } from './checks.ts';
import { mergeabilityRoute, refreshDecision, capRefreshes, zeroDiffGate, cycleCapExceeded, approvedReverify, refreshWins } from './gates.ts';
import { toReviewNode, toCheckContexts, assigneeLoginsOf } from './wire.ts';
import { refreshSweepWrite, zeroDiffWrite, cycleCapWrite, approvalWithdrawnWrite } from './writes.ts';

// port-tick.ts passes the same accumulator through the whole step sequence.
export interface PlanAccumulator {
  readonly dispatch: any[];
  readonly gates: any[];
  readonly held: any[];
  readonly announce: any[];
  readonly writes: any[];
  readonly refreshCandidates: any[];
  readonly refreshedUpdates: any[];
  readonly unknownStreakUpdates: any[];
}

export function freshAccumulator(): PlanAccumulator {
  return { dispatch: [], gates: [], held: [], announce: [], writes: [], refreshCandidates: [], refreshedUpdates: [], unknownStreakUpdates: [] };
}

// Ownership partition, every trigger/gate/in-flight alias.
export function partitionAliases(repository: any, viewer: string | null, aliasSpecs: readonly [string, string | null][]): Record<string, any> {
  const partitions: Record<string, any> = {};
  for (const [alias] of aliasSpecs) {
    const set = repository[alias];
    partitions[alias] = set ? partitionOwnership(set.nodes, viewer, assigneeLoginsOf) : { mine: [], others: [], unowned: [] };
  }
  return partitions;
}

// ready/planChangesRequested dispatch; planApproved's session-required check
// then the file-contention gate; refreshBranch always to revise-agent.
export function planTriggers(cfg: any, actionable: any, partitions: Record<string, any>, acc: PlanAccumulator): void {
  for (const item of actionable.ready.mine) acc.dispatch.push({ stage: 'plan-agent', item: item.number, kind: 'plan', model: cfg.models.plan, reason: 'ready' });
  for (const item of actionable.planChangesRequested.mine) acc.dispatch.push({ stage: 'plan-agent', item: item.number, kind: 'plan-revision', model: cfg.models.plan, reason: 'plan changes requested' });

  const inFlightClaims: any[] = [];
  for (const item of partitions.inProgress.mine) {
    inFlightClaims.push({ item: item.number, label: 'in progress', paths: parseFilesBlock(item.body) ?? [] });
  }
  for (const item of partitions.prOpened.mine) {
    inFlightClaims.push({ item: item.number, label: 'pr opened', paths: parseFilesBlock(item.body) ?? [] });
  }

  const structuredCandidates: any[] = [];
  for (const item of actionable.planApproved.mine) {
    const reason = issueSessionRequiredReason(item.body);
    if (reason) {
      acc.announce.push({ kind: 'session-required-issue', item: item.number, facts: { reason } });
      continue;
    }
    const paths = parseFilesBlock(item.body);
    if (paths === null) {
      acc.dispatch.push({ stage: 'impl-agent', item: item.number, kind: 'impl', model: cfg.models.impl, reason: 'unstructured plan — dispatched unchecked' });
      continue;
    }
    structuredCandidates.push({ item: item.number, paths });
  }
  const gated = gateCandidates(structuredCandidates, inFlightClaims, cfg.concurrency.sharedFiles, cfg.concurrency.overlapThreshold);
  for (const n of gated.dispatch) acc.dispatch.push({ stage: 'impl-agent', item: n, kind: 'impl', model: cfg.models.impl, reason: 'plan approved' });
  for (const h of gated.held) acc.held.push(h);

  for (const item of actionable.refreshBranch.mine) {
    acc.dispatch.push({ stage: 'revise-agent', item: item.number, kind: 'refresh', model: cfg.models.revise, reason: 'refresh branch' });
  }
}

// Mergeability routing, the zero-diff gate, then dispatch — vetoed first by
// refreshWins; a CONFLICTING read goes to acc.refreshCandidates instead.
export function planReadyForReview(cfg: any, actionable: any, refreshBranchNumbers: number[], refreshingNumbers: number[], unknownStreakState: Record<string, number>, acc: PlanAccumulator): void {
  for (const item of actionable.readyForReview.mine) {
    const veto = refreshWins({ number: item.number, refreshBranch: refreshBranchNumbers, refreshing: refreshingNumbers });
    if (veto.action === 'veto') {
      acc.announce.push({ kind: 'refresh-in-flight', item: item.number, facts: { label: veto.label } });
      continue;
    }

    if (item.mergeable === 'CONFLICTING') {
      acc.refreshCandidates.push({ number: item.number, headRefOid: item.headRefOid, sourceLabelKey: 'readyForReview' });
      continue;
    }

    if (item.mergeable === 'UNKNOWN') {
      const route = mergeabilityRoute('UNKNOWN', unknownStreakState[item.number] ?? 0);
      if (route.action === 'hold') {
        acc.announce.push({ kind: 'mergeability-unknown', item: item.number, facts: {} });
        acc.unknownStreakUpdates.push({ item: item.number, streak: route.unknownStreak });
        continue;
      }
      acc.unknownStreakUpdates.push({ item: item.number, remove: true });
    } else if (unknownStreakState[item.number] != null) {
      acc.unknownStreakUpdates.push({ item: item.number, remove: true });
    }

    const zd = zeroDiffGate({ reviews: (item.reviews?.nodes ?? []).map(toReviewNode), comments: item.comments?.nodes, headRefOid: item.headRefOid });
    if (zd.action === 'escalate') {
      acc.writes.push(zeroDiffWrite({ repo: cfg.repo, labels: cfg.labels, number: item.number }));
      acc.announce.push({ kind: 'zero-diff', item: item.number, facts: {} });
      continue;
    }
    acc.dispatch.push({ stage: 'review-agent', item: item.number, kind: 'review', model: cfg.models.review, reason: 'ready for review' });
  }
}

// Refresh-wins veto, session-required, then the unconditional cycle cap.
export function planNeedsRevision(cfg: any, actionable: any, refreshBranchNumbers: number[], refreshingNumbers: number[], acc: PlanAccumulator): void {
  for (const item of actionable.needsRevision.mine) {
    const veto = refreshWins({ number: item.number, refreshBranch: refreshBranchNumbers, refreshing: refreshingNumbers });
    if (veto.action === 'veto') {
      acc.announce.push({ kind: 'refresh-in-flight', item: item.number, facts: { label: veto.label } });
      continue;
    }

    const reason = prSessionRequiredReason(item.body);
    if (reason) {
      acc.announce.push({ kind: 'session-required-pr', item: item.number, facts: { reason } });
      continue;
    }
    if (cycleCapExceeded((item.reviews?.nodes ?? []).map(toReviewNode), cfg.reviewCycleCap)) {
      acc.writes.push(cycleCapWrite({ repo: cfg.repo, labels: cfg.labels, number: item.number }));
      acc.announce.push({ kind: 'cycle-cap', item: item.number, facts: { cap: cfg.reviewCycleCap } });
      continue;
    }
    acc.dispatch.push({ stage: 'revise-agent', item: item.number, kind: 'revise', model: cfg.models.revise, reason: 'needs revision' });
  }
}

// The approved re-verify: refresh-wins veto, then rollupVerdict/approvedReverify.
export function planApproved(cfg: any, actionable: any, refreshBranchNumbers: number[], refreshingNumbers: number[], acc: PlanAccumulator): void {
  const dispositions = cfg.checkDispositions;
  for (const item of actionable.approved.mine) {
    const veto = refreshWins({ number: item.number, refreshBranch: refreshBranchNumbers, refreshing: refreshingNumbers });
    if (veto.action === 'veto') {
      acc.announce.push({ kind: 'refresh-in-flight', item: item.number, facts: { label: veto.label } });
      continue;
    }

    const rollup = item.commits?.nodes?.[0]?.commit?.statusCheckRollup;
    const verdict = rollupVerdict(toCheckContexts(rollup), dispositions);
    const result = approvedReverify({ verdict, mergeable: item.mergeable });
    if (result.action === 'withdraw') {
      acc.writes.push(approvalWithdrawnWrite({ repo: cfg.repo, labels: cfg.labels, number: item.number }));
      acc.announce.push({ kind: 'approval-withdrawn', item: item.number, facts: { red: result.red } });
    } else if (result.action === 'refresh-in-place') {
      acc.refreshCandidates.push({ number: item.number, headRefOid: item.headRefOid, sourceLabelKey: 'approved' });
    } else if (result.action === 'announce-ready') {
      acc.announce.push({ kind: 'approved-ready', item: item.number, facts: { green: result.green } });
    }
  }
}

// Bounds acc.refreshCandidates to 5 per tick, oldest first; the remainder
// stays CONFLICTING and is reconsidered next tick.
export function planRefreshSweep(cfg: any, refreshedState: Record<string, any>, acc: PlanAccumulator): void {
  const { toRefresh, deferred } = capRefreshes(acc.refreshCandidates, 5);
  for (const c of deferred) {
    acc.announce.push({ kind: 'refresh-deferred', item: c.number, facts: {} });
  }
  for (const c of toRefresh) {
    const decision = refreshDecision(refreshedState[c.number], c.headRefOid);
    acc.writes.push(refreshSweepWrite({ repo: cfg.repo, labels: cfg.labels, candidate: c, decision }));
    if (decision.action === 'escalate') {
      acc.announce.push({ kind: 'refresh-stuck', item: c.number, facts: { reason: decision.reason, headRefOid: c.headRefOid } });
      acc.refreshedUpdates.push({ item: c.number, remove: true });
      continue;
    }
    acc.dispatch.push({ stage: 'revise-agent', item: c.number, kind: 'refresh', model: cfg.models.revise, reason: 'refresh sweep' });
    acc.announce.push({ kind: 'rebase-required', item: c.number, facts: { headRefOid: c.headRefOid, base: cfg.integration, approvalStands: c.sourceLabelKey === 'approved' } });
    acc.refreshedUpdates.push({ item: c.number, sha: c.headRefOid, count: decision.count });
  }
}

// plan-review/needs-human (real human gates) and blocked (report-only).
export function planHumanGates(actionable: any, acc: PlanAccumulator): void {
  for (const item of actionable.planReview.mine) {
    acc.gates.push({ kind: 'plan-review', item: item.number, facts: {} });
  }
  for (const item of actionable.needsHuman.mine) {
    acc.gates.push({ kind: 'needs-human', item: item.number, facts: {} });
  }
  for (const item of actionable.blocked.mine) {
    acc.announce.push({ kind: 'blocked', item: item.number, facts: {} });
  }
}
