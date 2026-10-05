// Pure: the `port-overrides` parser and resolver — issue #246,
// plugins/port/docs/PIPELINE.md → "CLAUDE.md overrides". No I/O and no `gh`
// spawn: config.ts reads CLAUDE.md off disk and hands this module the text,
// so the engine's read-only rail (scripts/checks/tick.ts) covers this file
// unchanged.
//
// `commands.*` and `extraAllow` stay schema-only, no exception — the
// permission surface the guard hook allowlists stage-agent Bash calls from.
// Every other `.claude/port.config.json`-governed category is overridable
// through one delimited block in a repository's own root `CLAUDE.md`, so a
// contradicting local convention wins over the port default without being
// negotiated away in prose (#121, #125).

export const BEGIN = '<!-- port-overrides:begin -->';
export const END = '<!-- port-overrides:end -->';
const FENCE_START = '```port-overrides';
const FENCE_END = '```';

/** The nine overridable path prefixes from PIPELINE.md → "CLAUDE.md
 *  overrides" → the category table. `checks.<name>` is synthetic — no
 *  `port.config.json` field backs it, since check dispositions were
 *  previously derived alone (the approval-gate carve-out); it is still the
 *  first consumer of this general mechanism. */
export const OVERRIDABLE = [
  'checks',
  'labels',
  'branches.integration',
  'branches.production',
  'models.plan',
  'models.impl',
  'models.review',
  'models.revise',
  'modules.approvalGate',
  'modules.release',
  'modules.scope',
  'reviewCycleCap',
  'concurrency.overlapThreshold',
  'concurrency.sharedFiles',
  'sessionRequiredPaths',
];

/** Every other top-level `port.config.json` key, refused by default — a
 *  schema key added later and never classified here fails closed rather than
 *  silently becoming overridable. `commands` and `extraAllow` are the
 *  permission surface (`PERMISSION_SURFACE` below) and carry their own
 *  refusal reason; the rest are refused as simply not overridable. */
export const NEVER_OVERRIDABLE = ['commands', 'extraAllow', 'repo', 'tracker', 'docs', 'release', 'budget', '$schema'];

/** The two paths free-form prose could otherwise use to expand a dispatched
 *  agent's shell authority — refused by name, no exception, ever. */
export const PERMISSION_SURFACE = new Set(['commands', 'extraAllow']);

/** Only these two accept `+=`, and only ever append — narrowing either would
 *  produce a dispatched agent that dies on a permission prompt against a
 *  harness boundary settings cannot grant back. */
const APPEND_ONLY = new Set(['sessionRequiredPaths', 'concurrency.sharedFiles']);

/** The effective-config shape every `readPath`/`writePath` dotted path
 *  resolves against — the cockpit's own `config.ts`'s `loadConfig` return at
 *  minimum. `applyOverrides` is generic over `C extends EffectiveConfigShape`
 *  so a caller (the app's own `ResolvedRepoConfig`) can carry further fields
 *  through untouched. */
export interface EffectiveConfigShape {
  integration: string;
  production: string | null;
  labels: Record<string, string>;
  models: { plan: string; impl: string; review: string; revise: string };
  modules: { approvalGate: boolean; release: boolean; scope: boolean };
  reviewCycleCap: number;
  concurrency: { sharedFiles: readonly string[]; overlapThreshold: number };
  sessionRequiredPaths: readonly string[];
}

export type OverrideValue = string | number | boolean | null;

export interface AppliedOverride {
  readonly path: string;
  readonly value: OverrideValue;
  readonly reason: string;
  readonly portDefault: OverrideValue | readonly string[] | undefined;
  readonly source: 'CLAUDE.md';
}

export interface OverrideEntry {
  path: string;
  op: '=' | '+=';
  rawValue: string;
  reason: string;
  line: string;
}

export interface OverrideProblem {
  line: string;
  reason: string;
}

/** Splits `line` on the first ` = ` or ` += ` — never on whitespace alone,
 *  which is what lets `checks.<name>` carry a check name containing spaces
 *  without quoting. Returns `null` when neither operator appears. */
function splitOperator(line: string): { path: string; op: '=' | '+='; rest: string } | null {
  const m = / (\+=|=) /.exec(line);
  if (!m) return null;
  return { path: line.slice(0, m.index).trim(), op: m[1] as '=' | '+=', rest: line.slice(m.index + m[0].length) };
}

/** Extracts the single ` ```port-overrides ` fence between the
 *  `<!-- port-overrides:begin/:end -->` markers and parses it into entries
 *  plus problems. **Absent block → `{ entries: [], problems: [] }`** — not a
 *  refusal, and nothing is reported. **At most one block per file** — a
 *  second is reported as a problem and only the first is read. A line that
 *  fails to parse is a problem, never a thrown error: a malformed block
 *  never aborts the caller. */
export function parseOverrides(text: string): { entries: OverrideEntry[]; problems: OverrideProblem[] } {
  const entries: OverrideEntry[] = [];
  const problems: OverrideProblem[] = [];

  const beginIdx = text.indexOf(BEGIN);
  if (beginIdx === -1) return { entries, problems };

  const endIdx = text.indexOf(END, beginIdx + BEGIN.length);
  if (endIdx === -1) {
    problems.push({ line: BEGIN, reason: `'${BEGIN}' has no matching '${END}'` });
    return { entries, problems };
  }

  const secondBeginIdx = text.indexOf(BEGIN, endIdx + END.length);
  if (secondBeginIdx !== -1) {
    problems.push({ line: BEGIN, reason: 'a second port-overrides block was found — only the first is read, never merged' });
  }

  const block = text.slice(beginIdx + BEGIN.length, endIdx);
  const fenceStart = block.indexOf(FENCE_START);
  if (fenceStart === -1) {
    problems.push({ line: BEGIN, reason: `the block carries no '${FENCE_START}' fence` });
    return { entries, problems };
  }
  const afterFenceStart = fenceStart + FENCE_START.length;
  const fenceEnd = block.indexOf(FENCE_END, afterFenceStart);
  if (fenceEnd === -1) {
    problems.push({ line: FENCE_START, reason: 'the port-overrides fence never closes' });
    return { entries, problems };
  }

  const body = block.slice(afterFenceStart, fenceEnd);
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;

    const split = splitOperator(line);
    if (!split) {
      problems.push({ line, reason: "no ' = ' or ' += ' operator found" });
      continue;
    }
    const { path, op, rest } = split;
    if (path === '') {
      problems.push({ line, reason: 'empty path before the operator' });
      continue;
    }
    if (/[*?]/.test(path)) {
      problems.push({ line, reason: 'no globs on the left-hand side' });
      continue;
    }

    const hashIdx = rest.indexOf(' # ');
    if (hashIdx === -1) {
      problems.push({ line, reason: "missing required reason (no ' # ' comment)" });
      continue;
    }
    const rawValue = rest.slice(0, hashIdx).trim();
    const reason = rest.slice(hashIdx + ' # '.length).trim();
    if (reason === '') {
      problems.push({ line, reason: 'a reason is required — an undocumented override is what this mechanism forbids' });
      continue;
    }
    if (rawValue === '') {
      problems.push({ line, reason: 'empty value before the reason' });
      continue;
    }

    entries.push({ path, op, rawValue, reason, line });
  }

  return { entries, problems };
}

/** Reads `path` (the same dotted grammar `parseOverrides` produces) off the
 *  **effective config shape** `config.ts`'s `loadConfig` builds — flattened,
 *  never the raw `branches`-nested `port.config.json` shape. Returns
 *  `'blocking'` for `checks.<name>` — that category has no config field of
 *  its own (folded into `checkDispositions` by the caller instead), but
 *  `PIPELINE.md` → "CLAUDE.md overrides" names `blocking` as the implicit
 *  port default every unlisted check name carries, so that is the real
 *  `portDefault` an applied `checks.*` override replaced, never
 *  `undefined`. */
function readPath(cfg: EffectiveConfigShape, path: string): OverrideValue | readonly string[] | undefined {
  switch (path) {
    case 'branches.integration':
      return cfg.integration;
    case 'branches.production':
      return cfg.production;
    case 'models.plan':
    case 'models.impl':
    case 'models.review':
    case 'models.revise': {
      const key = path.slice('models.'.length) as keyof EffectiveConfigShape['models'];
      return cfg.models[key];
    }
    case 'modules.approvalGate':
    case 'modules.release':
    case 'modules.scope': {
      const key = path.slice('modules.'.length) as keyof EffectiveConfigShape['modules'];
      return cfg.modules[key];
    }
    case 'reviewCycleCap':
      return cfg.reviewCycleCap;
    case 'concurrency.overlapThreshold':
      return cfg.concurrency.overlapThreshold;
    case 'concurrency.sharedFiles':
      return cfg.concurrency.sharedFiles;
    case 'sessionRequiredPaths':
      return cfg.sessionRequiredPaths;
    default:
      if (path.startsWith('checks.')) return 'blocking';
      if (path.startsWith('labels.')) return cfg.labels[path.slice('labels.'.length)];
      return undefined;
  }
}

/** The mirror of `readPath` — writes `value` into the same field, appending
 *  rather than assigning for the two `+=`-only paths. `typeof`-narrows
 *  before every write — a mismatched type writes nothing, unreachable since
 *  `validate` already produced the value. */
function writePath(cfg: EffectiveConfigShape, path: string, value: OverrideValue): void {
  switch (path) {
    case 'branches.integration':
      if (typeof value === 'string') cfg.integration = value;
      return;
    case 'branches.production':
      if (typeof value === 'string' || value === null) cfg.production = value;
      return;
    case 'models.plan':
    case 'models.impl':
    case 'models.review':
    case 'models.revise':
      if (typeof value === 'string') cfg.models[path.slice('models.'.length) as keyof EffectiveConfigShape['models']] = value;
      return;
    case 'modules.approvalGate':
    case 'modules.release':
    case 'modules.scope':
      if (typeof value === 'boolean') cfg.modules[path.slice('modules.'.length) as keyof EffectiveConfigShape['modules']] = value;
      return;
    case 'reviewCycleCap':
      if (typeof value === 'number') cfg.reviewCycleCap = value;
      return;
    case 'concurrency.overlapThreshold':
      if (typeof value === 'number') cfg.concurrency.overlapThreshold = value;
      return;
    case 'concurrency.sharedFiles':
      if (typeof value === 'string') cfg.concurrency.sharedFiles = [...cfg.concurrency.sharedFiles, value];
      return;
    case 'sessionRequiredPaths':
      if (typeof value === 'string') cfg.sessionRequiredPaths = [...cfg.sessionRequiredPaths, value];
      return;
    default:
      if (path.startsWith('labels.') && typeof value === 'string') cfg.labels[path.slice('labels.'.length)] = value;
  }
}

/** Classifies and type-checks one parsed entry against `path`'s category,
 *  returning either the coerced `value` to apply or a refusal `reason`.
 *  `labelKeys` is `config.ts`'s `LABEL_DEFAULTS` key set — the only category
 *  whose valid values depend on more than the entry itself. */
function validate(entry: OverrideEntry, labelKeys: readonly string[]): { value: OverrideValue } | { reason: string } {
  const { path, op, rawValue } = entry;

  const top = path.split('.')[0] ?? path;
  if (NEVER_OVERRIDABLE.includes(top) || NEVER_OVERRIDABLE.includes(path)) {
    return {
      reason: PERMISSION_SURFACE.has(top)
        ? `'${path}' is the permission surface the guard hook allowlists from — never overridable, no exception`
        : `'${path}' is not overridable`,
    };
  }

  const appendOnly = APPEND_ONLY.has(path);
  if (appendOnly && op !== '+=') return { reason: `'${path}' only ever appends — use '+=', never '='` };
  if (!appendOnly && op === '+=') return { reason: `'${path}' is not append-only — use '=', never '+='` };

  if (path.startsWith('checks.') && path.length > 'checks.'.length) {
    if (rawValue !== 'blocking' && rawValue !== 'infrastructure') {
      return { reason: `'${path}' must be 'blocking' or 'infrastructure', got '${rawValue}'` };
    }
    return { value: rawValue };
  }

  if (path.startsWith('labels.') && path.length > 'labels.'.length) {
    const key = path.slice('labels.'.length);
    if (!labelKeys.includes(key)) return { reason: `'${key}' is not a key in the label vocabulary` };
    return { value: rawValue };
  }

  if (path === 'branches.production') return { value: rawValue === 'null' ? null : rawValue };
  if (path === 'branches.integration') return { value: rawValue };
  if (path.startsWith('models.')) return { value: rawValue };

  if (path.startsWith('modules.')) {
    if (rawValue !== 'true' && rawValue !== 'false') return { reason: `'${path}' must be 'true' or 'false', got '${rawValue}'` };
    return { value: rawValue === 'true' };
  }

  if (path === 'reviewCycleCap' || path === 'concurrency.overlapThreshold') {
    const n = Number(rawValue);
    if (!Number.isInteger(n) || n < 1) return { reason: `'${path}' must be an integer ≥ 1, got '${rawValue}'` };
    return { value: n };
  }

  if (path === 'concurrency.sharedFiles' || path === 'sessionRequiredPaths') {
    return { value: rawValue };
  }

  return { reason: `'${path}' is not a recognized overridable path` };
}

/** Folds `parsed` over `cfg` (the effective-config shape `loadConfig`
 *  already resolved from `.claude/port.config.json` alone) to produce the
 *  final effective config. **Fails closed on the entry, open on the run**: a
 *  refused entry leaves the port value standing for that one field and is
 *  reported; nothing else in the block is affected, and a wholly malformed
 *  block never aborts config loading. `cfg` is never mutated — a fresh
 *  object is returned. */
export function applyOverrides<C extends EffectiveConfigShape>(
  cfg: C,
  parsed: { entries: readonly OverrideEntry[]; problems: readonly OverrideProblem[] },
  opts: { labelKeys: readonly string[] },
): { cfg: C; applied: AppliedOverride[]; refused: { path: string | null; line: string; reason: string }[] } {
  const out: C = structuredClone(cfg);
  const applied: AppliedOverride[] = [];
  const refused: { path: string | null; line: string; reason: string }[] = parsed.problems.map((p) => ({ path: null, line: p.line, reason: p.reason }));

  for (const entry of parsed.entries) {
    const result = validate(entry, opts.labelKeys);
    if ('reason' in result) {
      refused.push({ path: entry.path, line: entry.line, reason: result.reason });
      continue;
    }
    const portDefault = readPath(out, entry.path);
    writePath(out, entry.path, result.value);
    applied.push({ path: entry.path, value: result.value, reason: entry.reason, portDefault, source: 'CLAUDE.md' });
  }

  return { cfg: out, applied, refused };
}
