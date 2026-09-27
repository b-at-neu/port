// Reads .claude/port.config.json and resolves everything the tick engine
// needs from it: the label vocabulary (pinned to data/labels.json,
// checked by scripts/checks/tick.ts), models, modules, concurrency, and the
// review cycle cap. No path is string-concatenated — node:path only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { message } from '../lib/errors.ts';
import { parseOverrides, applyOverrides } from './overrides.ts';

// Defaults and roles mirror plugins/port/docs/PIPELINE.md → "Label lifecycle"
// and plugins/port/data/labels.json exactly — the pin check in
// scripts/checks/tick.ts asserts both directions.
export const LABEL_DEFAULTS = {
  marker: 'claude',
  autoPlan: 'auto plan',
  ready: 'ready',
  planChangesRequested: 'plan changes requested',
  planApproved: 'plan approved',
  readyForReview: 'ready for review',
  needsRevision: 'needs revision',
  refreshBranch: 'refresh branch',
  planning: 'planning',
  inProgress: 'in progress',
  reviewing: 'reviewing',
  revising: 'revising',
  refreshing: 'refreshing',
  planReview: 'plan review',
  blocked: 'blocked',
  needsHuman: 'needs human',
  prOpened: 'pr opened',
  approved: 'approved',
};

export const LABEL_ROLES = {
  marker: 'marker',
  autoPlan: 'marker',
  ready: 'trigger',
  planChangesRequested: 'trigger',
  planApproved: 'trigger',
  readyForReview: 'trigger',
  needsRevision: 'trigger',
  refreshBranch: 'trigger',
  planning: 'in-flight',
  inProgress: 'in-flight',
  reviewing: 'in-flight',
  revising: 'in-flight',
  refreshing: 'in-flight',
  planReview: 'gate',
  blocked: 'gate',
  needsHuman: 'gate',
  prOpened: 'terminal',
  approved: 'terminal',
};

// #236: livenessResetWrite (and every other writes.ts export) hardcoded
// `target: 'issue'`, wrong for the three in-flight labels that only ever
// apply to a pull request. This map is what `writes.ts`'s `labelEdit` reads
// instead of assuming a surface — deliberately **no runtime default**:
// defaulting to `'issue'` is the exact bug this map exists to prevent, and
// the `tick-labels` coverage pin (scripts/checks/tick.ts) is what makes a
// key missing from this map unreachable rather than silently mis-targeted.
// Pinned against query.ts's `issueSet`/`prSet` call sites by `tick-surface`
// (docs/ENGINEERING.md §2), so the two facts can never drift apart silently.
export const LABEL_SURFACE = {
  ready: 'issue',
  planChangesRequested: 'issue',
  planApproved: 'issue',
  planning: 'issue',
  inProgress: 'issue',
  planReview: 'issue',
  blocked: 'issue',
  prOpened: 'issue',
  readyForReview: 'pr',
  needsRevision: 'pr',
  refreshBranch: 'pr',
  reviewing: 'pr',
  revising: 'pr',
  refreshing: 'pr',
  needsHuman: 'pr',
  approved: 'pr',
  marker: 'both',
  autoPlan: 'issue',
};

/** `labels[key] ?? default` — the repository's override when `labels` sets
 *  one, otherwise the standard name. Pure, so it is directly unit-testable. */
export function resolveLabels(cfg: any): Record<string, string> {
  const overrides = cfg.labels ?? {};
  const out: Record<string, string> = {};
  for (const key of Object.keys(LABEL_DEFAULTS)) {
    out[key] = overrides[key] ?? (LABEL_DEFAULTS as Record<string, string>)[key];
  }
  return out;
}

/** Reads and resolves `.claude/port.config.json` at `repoRoot`. Throws with a
 *  named reason on anything the CLI must report as a hard `exit 1` — missing
 *  file, unparseable JSON, or no `repo` — rather than returning a half-filled
 *  config a caller might use by accident. */
export function loadConfig(repoRoot: string): any {
  const path = join(repoRoot, '.claude', 'port.config.json');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`'.claude/port.config.json' not found at '${path}' — this repository is not port-managed`);
  }
  let cfg: any;
  try {
    cfg = JSON.parse(text);
  } catch (e) {
    throw new Error(`'.claude/port.config.json' does not parse as JSON: ${message(e)}`);
  }
  if (!cfg.repo) throw new Error("'.claude/port.config.json' declares no 'repo'");
  const [owner, name] = cfg.repo.split('/');
  if (!owner || !name) throw new Error(`'.claude/port.config.json's 'repo' must be 'owner/name', got '${cfg.repo}'`);

  const hasProduction = Object.hasOwn(cfg.branches ?? {}, 'production');

  const resolved = {
    repo: cfg.repo,
    owner,
    name,
    integration: cfg.branches?.integration ?? 'dev',
    production: hasProduction ? cfg.branches.production : 'main',
    labels: resolveLabels(cfg),
    models: {
      plan: cfg.models?.plan ?? 'opus',
      impl: cfg.models?.impl ?? 'sonnet',
      review: cfg.models?.review ?? 'sonnet',
      revise: cfg.models?.revise ?? 'sonnet',
    },
    modules: {
      approvalGate: cfg.modules?.approvalGate ?? true,
      release: cfg.modules?.release ?? true,
      scope: cfg.modules?.scope ?? true,
    },
    reviewCycleCap: cfg.reviewCycleCap ?? 5,
    concurrency: {
      sharedFiles: cfg.concurrency?.sharedFiles ?? [],
      overlapThreshold: cfg.concurrency?.overlapThreshold ?? 2,
    },
    sessionRequiredPaths: cfg.sessionRequiredPaths ?? ['CLAUDE.md', '.claude/**'],
    commandsTick: cfg.commands?.tick ?? null,
    commandsWorktrees: cfg.commands?.worktrees ?? null,
    // The `run-start` event's config facts (#187) — read from the *raw*
    // parsed JSON, never the already-resolved `labels` above: only the keys
    // the repository actually overrode are interesting, not every key's
    // resolved name.
    labelsOverridden: Object.keys(cfg.labels ?? {}),
    budgetConfigured: Boolean(cfg.commands?.budget),
  };

  // CLAUDE.md overrides (#246) — a repository's own root CLAUDE.md, never
  // ~/.claude/CLAUDE.md, applied after every port.config.json default has
  // already resolved. Absent file → empty parse, no problem reported, and
  // the effective config is byte-identical to `resolved` above.
  let claudeMdText = '';
  try {
    claudeMdText = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8');
  } catch {
    // No repository-root CLAUDE.md — every category runs on the port default.
  }
  const parsedOverrides = parseOverrides(claudeMdText);
  const { cfg: effective, applied, refused } = applyOverrides(resolved, parsedOverrides, {
    labelKeys: Object.keys(LABEL_DEFAULTS),
  });

  // Check dispositions (#246): the approval-gate carve-out folds in first,
  // as `source: 'approval-gate'`, resolved against the *effective*
  // modules.approvalGate — an override to that flag must be able to turn the
  // carve-out itself off. Every `checks.<name>` applied entry follows, as
  // `source: 'CLAUDE.md'`. A later `applied` entry never overwrites the
  // approval-gate's own name — the two sources cannot collide, since the
  // workflow file's job key is never a name an operator would also write by
  // hand into the block for the same disposition value.
  const excusedCheckName = resolveExcusedCheckName(repoRoot, effective.modules);
  const checkDispositions: Record<string, { disposition: 'blocking' | 'infrastructure'; source: 'approval-gate' | 'CLAUDE.md' }> = {};
  if (excusedCheckName) checkDispositions[excusedCheckName] = { disposition: 'infrastructure', source: 'approval-gate' };
  for (const a of applied) {
    if (a.path.startsWith('checks.')) {
      checkDispositions[a.path.slice('checks.'.length)] = { disposition: a.value, source: 'CLAUDE.md' };
    }
  }

  return { ...effective, overrides: { applied, refused }, checkDispositions };
}

/** The single job key under `jobs:` in `.github/workflows/approval-check.yml`
 *  — the approval-gate's own excused check-run name, folded into
 *  `loadConfig`'s `checkDispositions` map as `source: 'approval-gate'`, per
 *  plugins/port/docs/PIPELINE.md → "Check evidence" → "Dispositions".
 *  Derived from the file, never typed as a literal. Returns `null` when
 *  `modules.approvalGate` is false or the workflow file is absent — no
 *  carve-out at all, and every red check blocks. A minimal line-based read,
 *  not a YAML parser — the stack carries zero runtime dependencies, and this
 *  file's shape (one job, two-space indent) is fixed by the template that
 *  writes it. */
export function resolveExcusedCheckName(repoRoot: string, modules: any): string | null {
  if (!modules.approvalGate) return null;
  const path = join(repoRoot, '.github', 'workflows', 'approval-check.yml');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const jobsIdx = text.indexOf('\njobs:');
  if (jobsIdx === -1) return null;
  const after = text.slice(jobsIdx + '\njobs:'.length);
  const m = /\n {2}([A-Za-z0-9_-]+):/.exec(after);
  return m ? m[1] : null;
}
