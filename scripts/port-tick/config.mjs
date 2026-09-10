// Reads .claude/port.config.json and resolves everything the tick engine
// needs from it: the label vocabulary (pinned to templates/labels.json,
// checked by scripts/checks/tick.mjs), models, modules, concurrency, and the
// review cycle cap. No path is string-concatenated — node:path only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Defaults and roles mirror plugins/port/docs/PIPELINE.md → "Label lifecycle"
// and plugins/port/templates/labels.json exactly — the pin check in
// scripts/checks/tick.mjs asserts both directions.
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

/** `labels[key] ?? default` — the repository's override when `labels` sets
 *  one, otherwise the standard name. Pure, so it is directly unit-testable. */
export function resolveLabels(cfg) {
  const overrides = cfg.labels ?? {};
  const out = {};
  for (const key of Object.keys(LABEL_DEFAULTS)) {
    out[key] = overrides[key] ?? LABEL_DEFAULTS[key];
  }
  return out;
}

/** Reads and resolves `.claude/port.config.json` at `repoRoot`. Throws with a
 *  named reason on anything the CLI must report as a hard `exit 1` — missing
 *  file, unparseable JSON, or no `repo` — rather than returning a half-filled
 *  config a caller might use by accident. */
export function loadConfig(repoRoot) {
  const path = join(repoRoot, '.claude', 'port.config.json');
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`'.claude/port.config.json' not found at '${path}' — this repository is not port-managed`);
  }
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (e) {
    throw new Error(`'.claude/port.config.json' does not parse as JSON: ${e.message}`);
  }
  if (!cfg.repo) throw new Error("'.claude/port.config.json' declares no 'repo'");
  const [owner, name] = cfg.repo.split('/');
  if (!owner || !name) throw new Error(`'.claude/port.config.json's 'repo' must be 'owner/name', got '${cfg.repo}'`);

  const hasProduction = Object.hasOwn(cfg.branches ?? {}, 'production');

  return {
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
  };
}

/** The single job key under `jobs:` in `.github/workflows/approval-check.yml`
 *  — the one check-run name the `<labels.approved>` re-verify excuses, per
 *  plugins/port/docs/PIPELINE.md → "Check evidence" → "The one carve-out".
 *  Derived from the file, never typed as a literal. Returns `null` when
 *  `modules.approvalGate` is false or the workflow file is absent — no
 *  carve-out at all, and every red check blocks. A minimal line-based read,
 *  not a YAML parser — the stack carries zero runtime dependencies, and this
 *  file's shape (one job, two-space indent) is fixed by the template that
 *  writes it. */
export function resolveExcusedCheckName(repoRoot, modules) {
  if (!modules.approvalGate) return null;
  const path = join(repoRoot, '.github', 'workflows', 'approval-check.yml');
  let text;
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
