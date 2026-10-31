#!/usr/bin/env node
// The pipeline's artifact contract, self-contained. `check <kind> <file>` validates offline;
// `audit` is a gh-driven pass over pull requests — NEVER add this to commands.checks.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// --- Label vocabulary --------------------------------------------------------
// Mirrors data/labels.json (key, default name, module); layer 1 asserts the two agree.
export const LABELS = {
  marker: { name: 'claude', module: 'core' },
  autoPlan: { name: 'auto plan', module: 'core' },
  ready: { name: 'ready', module: 'core' },
  planChangesRequested: { name: 'plan changes requested', module: 'core' },
  planApproved: { name: 'plan approved', module: 'core' },
  readyForReview: { name: 'ready for review', module: 'core' },
  needsRevision: { name: 'needs revision', module: 'core' },
  refreshBranch: { name: 'refresh branch', module: 'core' },
  planning: { name: 'planning', module: 'core' },
  inProgress: { name: 'in progress', module: 'core' },
  reviewing: { name: 'reviewing', module: 'core' },
  revising: { name: 'revising', module: 'core' },
  refreshing: { name: 'refreshing', module: 'core' },
  planReview: { name: 'plan review', module: 'core' },
  blocked: { name: 'blocked', module: 'core' },
  needsHuman: { name: 'needs human', module: 'core' },
  prOpened: { name: 'pr opened', module: 'core' },
  approved: { name: 'approved', module: 'core' },
};

// --- Format contracts --------------------------------------------------------
export const BODY_HEADINGS = ['## Summary', '## Changes', '## Testing plan', '## Automated checks'];
export const REVIEW_PREFIX = '## Code Review';
// Third verdict: posted when the head commit's checks never concluded within the bounded wait.
export const REVIEW_HEADING = /^## Code Review — Cycle (\d+) · (approved|needs revision|blocked — checks pending)$/;
export const REVISION_HEADING = /^## Revision — Cycle (\d+)$/;
export const APPROVAL_WITHDRAWN_HEADING = '## Approval withdrawn';
export const REBASE_REQUIRED_HEADING = '## Rebase required';
export const CHANGES_REQUESTED_HEADING = '## Changes requested';
export const SHA_RE = /\b[0-9a-f]{7,40}\b/;
// `fixed <ids> · skipped <ids> · <sha>`, either segment dropped when empty, or the
// check-fix-mode form `check <name> · <sha>` with neither segment at all.
export const REVISION_OPENS = /^(?:fixed|skipped|check)\b/;
export const REVISION_DETAIL = /^(?:(?:fixed\b[^·]*·\s*)?(?:skipped\b[^·]*·\s*)?[0-9a-f]{7,40}\b|check\s+\S+\s*·\s*[0-9a-f]{7,40}\b)/;
export const COMMIT_SUBJECT = /^#\d+ [a-z]/;
export const SCRATCH_PATHS = /^(\.temp|\.agents)\//;
// A verification step only the operator can run — a checkbox item opening with the bolded
// prefix. Never a bare substring search: a plan merely discussing the prefix is not marked.
export const OPERATOR_ONLY_STEP = /^\s*[-*]\s*\[[ xX]\]\s*\*\*operator-only\*\*/;
// The session-required marker's canonical rendering, anchored at line start. Detection is
// slot-plus-form, never a substring search — see PIPELINE.md → "Detection".
const SESSION_MARKER = /^>\s*\*\*SESSION REQUIRED:\*\*\s+\S/;

/** Pull request stage labels; legality is pair-wise, checked by
 *  `stageViolation` below, not by this list alone. */
export const PR_STAGE_KEYS = ['readyForReview', 'reviewing', 'needsRevision', 'revising', 'approved', 'needsHuman'];
/** The refresh pair — sanctioned beside a stage label, never twice over. */
export const PR_REFRESH_KEYS = ['refreshBranch', 'refreshing'];
/** Issue-side stage labels, the counterpart to `PR_STAGE_KEYS`. No refresh pair on this
 *  surface: the refresh labels only ever apply to a pull request. */
export const ISSUE_STAGE_KEYS = ['ready', 'planChangesRequested', 'planApproved', 'planning', 'inProgress', 'planReview', 'blocked', 'prOpened'];
const IN_FLIGHT_KEYS = ['planning', 'inProgress', 'reviewing', 'revising', 'refreshing'];
const TRIGGER_KEYS = ['ready', 'planChangesRequested', 'planApproved', 'readyForReview', 'needsRevision', 'refreshBranch'];

/** Pair-wise stage legality: at most one stage label, beside at most one refresh label.
 *  `null` means legal; both arguments are already-resolved label names. */
export function stageViolation(stages, refresh) {
  if (stages.length > 1) return `carries ${stages.length} stage labels at once: ${stages.join(', ')}`;
  if (refresh.length > 1) return `carries both refresh labels at once: ${refresh.join(', ')}`;
  return null;
}

// --- Small text helpers, shared by `check` and `audit` -----------------------
const lines = (text) => (text ?? '').replace(/\r\n/g, '\n').split('\n');
const has = (ls, heading) => ls.some((l) => l.trim() === heading);
/** The lines under `heading`, up to the next `## `. */
const section = (ls, heading) => {
  const start = ls.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  const rest = ls.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return end === -1 ? rest : rest.slice(0, end);
};
const firstNonEmpty = (ls) => ls.find((l) => l.trim() !== '') ?? '';
const firstNonEmptyIndex = (ls) => ls.findIndex((l) => l.trim() !== '');

/** One clear line, no stack trace — nothing here is a failure mode a trace helps with. */
const die = (msg) => {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
};

// --- check <kind> <file> --- Every rule below is the same one `audit` uses further down.
// Each returns `{ ok: true }` or `{ ok: false, detail, expected }`.
const ok = () => ({ ok: true });
const fail = (detail, expected) => ({ ok: false, detail, expected });

/** Every failing assertion, not just the first — `audit` reports each one independently,
 *  while `checkCommit` below surfaces only the first, since `check` reports one FAIL line. */
function commitViolations(text, { issue } = {}) {
  const violations = [];
  const ls = lines(text);
  const subject = ls[0] ?? '';
  if (!COMMIT_SUBJECT.test(subject)) {
    violations.push(fail(
      `subject must match '#<issue> <imperative lowercase summary>', got ${JSON.stringify(subject)}`,
      "'#<issue> <imperative lowercase summary>'",
    ));
  }
  if (subject.length >= 80) {
    violations.push(fail(`subject is ${subject.length} characters, must be under 80`, 'a subject under 80 characters'));
  }
  if (subject.endsWith('.')) {
    violations.push(fail('subject must not end with a period', 'a subject with no trailing period'));
  }
  if (issue != null) {
    const m = /^#(\d+)/.exec(subject);
    if (!m || Number(m[1]) !== Number(issue)) {
      violations.push(fail(`subject's issue number must be ${issue}, got ${JSON.stringify(subject)}`, `a subject starting '#${issue} '`));
    }
  }
  if (ls.length > 1 && ls[1].trim() !== '') {
    violations.push(fail('line 2 must be blank when a body follows the subject', 'a blank line 2'));
  }
  if (!/^Co-Authored-By:/im.test(text)) {
    violations.push(fail("message carries no 'Co-Authored-By:' trailer", "a 'Co-Authored-By: <name> <email>' trailer"));
  }
  return violations;
}

function checkCommit(text, opts = {}) {
  const violations = commitViolations(text, opts);
  return violations.length === 0 ? ok() : violations[0];
}

function checkPrBody(text, { issue } = {}) {
  const ls = lines(text);
  const first = (ls[0] ?? '').trim();
  const m = /^Closes #(\d+)$/.exec(first);
  if (!m) return fail(`first line must be 'Closes #<issue>', got ${JSON.stringify(first)}`, "'Closes #<issue>'");
  if (issue != null && Number(m[1]) !== Number(issue)) {
    return fail(`first line closes #${m[1]}, expected #${issue}`, `'Closes #${issue}'`);
  }
  for (const h of BODY_HEADINGS) {
    if (!has(ls, h)) return fail(`missing '${h}'`, `a '${h}' section`);
  }
  const plan = section(ls, '## Testing plan');
  if (!plan || !plan.some((l) => /^\s*[-*]\s*\[[ xX]\]/.test(l))) {
    return fail(
      "'## Testing plan' holds no '- [ ]' items — it must be a checklist a human runs",
      "at least one '- [ ] ...' item under '## Testing plan'",
    );
  }
  return ok();
}

function checkReview(text, { cycle } = {}) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (e) {
    return fail(`does not parse as JSON: ${e.message}`, 'a JSON object with event, body, comments');
  }
  if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(payload.event)) {
    return fail(`'event' must be COMMENT, APPROVE, or REQUEST_CHANGES, got ${JSON.stringify(payload.event)}`, "event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'");
  }
  const bodyLines = lines(payload.body ?? '');
  const first = (bodyLines[0] ?? '').trim();
  const m = REVIEW_HEADING.exec(first);
  if (!m) {
    return fail(
      `body line 1 must be '${REVIEW_PREFIX} — Cycle <n> · <approved|needs revision|blocked — checks pending>', got ${JSON.stringify(first)}`,
      `'${REVIEW_PREFIX} — Cycle <n> · <approved|needs revision|blocked — checks pending>'`,
    );
  }
  if (cycle != null && Number(m[1]) !== Number(cycle)) {
    return fail(`heading is cycle ${m[1]}, expected ${cycle}`, `'${REVIEW_PREFIX} — Cycle ${cycle} · ...'`);
  }
  if ((bodyLines[1] ?? '').trim() === '') {
    return fail('body line 2 must be a non-empty counts line', 'a non-empty counts line directly under the heading');
  }
  for (const c of payload.comments ?? []) {
    if (typeof c.path !== 'string' || c.path === '') {
      return fail('every comment needs a non-empty string path', '{ path, line, side, body }');
    }
    if (!Number.isInteger(c.line)) {
      return fail(`comment on '${c.path}' needs an integer 'line'`, 'an integer line');
    }
    if (c.side !== 'LEFT' && c.side !== 'RIGHT') {
      return fail(`comment on '${c.path}' needs side 'LEFT' or 'RIGHT', got ${JSON.stringify(c.side)}`, "side: 'LEFT' | 'RIGHT'");
    }
    if (typeof c.body !== 'string' || c.body === '') {
      return fail(`comment on '${c.path}' needs a non-empty body`, 'a non-empty body string');
    }
  }
  return ok();
}

function checkRevision(text, { cycle } = {}) {
  const ls = lines(text);
  const first = (ls[0] ?? '').trim();
  const m = REVISION_HEADING.exec(first);
  if (!m) return fail(`heading must be '## Revision — Cycle <n>', got ${JSON.stringify(first)}`, "'## Revision — Cycle <n>'");
  if (cycle != null && Number(m[1]) !== Number(cycle)) {
    return fail(`heading is cycle ${m[1]}, expected ${cycle}`, `'## Revision — Cycle ${cycle}'`);
  }
  const detail = firstNonEmpty(ls.slice(1)).trim();
  if (!REVISION_OPENS.test(detail) || !REVISION_DETAIL.test(detail)) {
    return fail(
      `needs one 'fixed … · skipped … · <sha>' or 'check <name> · <sha>' line, got ${JSON.stringify(detail)}`,
      "'fixed <ids> · skipped <ids> · <sha>' or 'check <name> · <sha>'",
    );
  }
  return ok();
}

/** Shared by `withdrawn` and `rebase-required`: heading on line 1, a 7-40 character hex SHA
 *  below it, and a backtick-quoted fact beside the SHA (`missingNoun` names it). */
function checkShaAnnotated(heading, missingNoun) {
  return (text) => {
    const ls = lines(text);
    const first = (ls[0] ?? '').trim();
    if (first !== heading) {
      return fail(`line 1 must be exactly '${heading}', got ${JSON.stringify(first)}`, `'${heading}'`);
    }
    const rest = ls.slice(1).join('\n');
    if (!SHA_RE.test(rest)) {
      return fail(`'${heading}' carries no 7-40 character hex SHA`, `'${heading}' followed by a 7-40 character hex SHA`);
    }
    const FULL_SHA = /^[0-9a-f]{7,40}$/;
    const backticked = [...rest.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (!backticked.some((b) => !FULL_SHA.test(b))) {
      return fail(`'${heading}' names no ${missingNoun} — only a SHA`, `a backtick-quoted ${missingNoun} alongside the SHA`);
    }
    return ok();
  };
}

/** `## Changes requested` — the cockpit's `revise #N` comment. Three checks: heading on line
 *  1, a hex SHA below it, and at least one non-empty line that is not the SHA itself. */
function checkChangesRequested(text) {
  const ls = lines(text);
  const first = (ls[0] ?? '').trim();
  if (first !== CHANGES_REQUESTED_HEADING) {
    return fail(`line 1 must be exactly '${CHANGES_REQUESTED_HEADING}', got ${JSON.stringify(first)}`, `'${CHANGES_REQUESTED_HEADING}'`);
  }
  const rest = ls.slice(1);
  const restText = rest.join('\n');
  const shaMatch = SHA_RE.exec(restText);
  if (!shaMatch) {
    return fail(`'${CHANGES_REQUESTED_HEADING}' carries no 7-40 character hex SHA`, `'${CHANGES_REQUESTED_HEADING}' followed by a 7-40 character hex SHA`);
  }
  const sha = shaMatch[0];
  const hasRequestText = rest.some((l) => l.trim() !== '' && !l.includes(sha));
  if (!hasRequestText) {
    return fail(`'${CHANGES_REQUESTED_HEADING}' carries only the SHA — no request text`, "a non-empty line besides the SHA (the operator's request, verbatim)");
  }
  return ok();
}

// One registry for both modes — kind -> { run, heading }; `null` marks the two kinds
// `audit` matches by shape, not heading.
export const CHECKS = {
  commit: { run: checkCommit, heading: null },
  'pr-body': { run: checkPrBody, heading: null },
  review: { run: checkReview, heading: REVIEW_HEADING },
  revision: { run: checkRevision, heading: REVISION_HEADING },
  withdrawn: { run: checkShaAnnotated(APPROVAL_WITHDRAWN_HEADING, 'check'), heading: APPROVAL_WITHDRAWN_HEADING },
  'rebase-required': { run: checkShaAnnotated(REBASE_REQUIRED_HEADING, 'base branch'), heading: REBASE_REQUIRED_HEADING },
  'changes-requested': { run: checkChangesRequested, heading: CHANGES_REQUESTED_HEADING },
};

function runCheck(argv) {
  const usage = `usage: node artifacts.mjs check <${Object.keys(CHECKS).join('|')}> <file> [--issue N] [--cycle N]`;
  const kind = argv[0];
  const file = argv[1];
  if (!kind || !CHECKS[kind]) die(`check does not recognize kind '${kind}'. ${usage}`);
  if (!file) die(`check needs a file. ${usage}`);

  const opts = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--issue') opts.issue = argv[++i];
    else if (a === '--cycle') opts.cycle = argv[++i];
    else die(`unrecognized argument '${a}'. ${usage}`);
  }

  if (!existsSync(file)) {
    console.error(`FAIL  ${kind}: file not found: ${file}`);
    console.error('expected: an existing file');
    process.exit(1);
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`FAIL  ${kind}: could not read ${file}: ${e.message}`);
    console.error('expected: a readable file');
    process.exit(1);
  }

  const result = CHECKS[kind].run(text, opts);
  if (result.ok) {
    console.log(`ok    ${kind} ${file}`);
    process.exit(0);
  }
  console.error(`FAIL  ${kind}: ${result.detail}`);
  console.error(`expected: ${result.expected}`);
  process.exit(1);
}

// --- audit [<pr>...] [--limit <n>] --- Walk up looking for `.claude/port.config.json`.
/** Only `audit` needs a repository root — `check` reads nothing but the file it was pointed at. */
function findRoot(startDir) {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, '.claude/port.config.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function runAudit(argv) {
  const root = findRoot(process.cwd());
  if (!root) die('.claude/port.config.json was not found in this or any parent directory — this repository is not port-managed.');

  const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

  const cfg = readJson('.claude/port.config.json');
  const repo = cfg.repo;
  if (!repo) die('.claude/port.config.json declares no `repo`.');

  const def = (key) => {
    const d = LABELS[key];
    if (!d) die(`no label is defined for key '${key}'.`);
    return d;
  };
  const label = (key) => cfg.labels?.[key] ?? def(key).name;
  const labelEnabled = (key) => {
    const { module } = def(key);
    return module === 'core' || cfg.modules?.[module] === true;
  };

  const marker = label('marker');

  function gh(args) {
    try {
      return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      if (e.code === 'ENOENT') {
        die('`gh` is not on PATH — this audit reads GitHub through the CLI. Install it and run `gh auth login`.');
      }
      const first = String(e.stderr ?? '').trim().split('\n')[0] || `exited ${e.status}`;
      die(`gh ${args.join(' ')} — ${first}`);
    }
  }
  const ghJson = (args) => JSON.parse(gh(args));

  const usage = 'usage: node artifacts.mjs audit [<pr>...] [--limit <n>]';
  const targets = [];
  let limit = 5;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') {
      limit = Number(argv[++i]);
      if (!Number.isInteger(limit) || limit < 1) die(`--limit needs a positive integer. ${usage}`);
    } else if (/^#?\d+$/.test(a)) {
      targets.push(Number(a.replace('#', '')));
    } else {
      die(`unrecognized argument '${a}'. ${usage}`);
    }
  }

  const failures = [];
  const notes = [];
  let checked = 0;
  const auditFail = (check, detail) => failures.push(`${check}: ${detail}`);
  const note = (text) => notes.push(text);
  const auditOk = () => checked++;
  /** Fold a `check*` result into the audit's collector, so both modes share the same functions. */
  const fold = (at, result) => (result.ok ? auditOk() : auditFail(at, result.detail));

  const sweep = targets.length === 0;
  if (sweep) {
    const recent = ghJson([
      'pr', 'list', '--repo', repo, '--state', 'all',
      '--label', marker, '--limit', String(limit), '--json', 'number',
    ]);
    if (recent.length === 0) note(`no pull requests carry '${marker}' — nothing to audit`);
    targets.push(...recent.map((p) => p.number));
  }

  const PR_FIELDS = 'number,state,body,labels,author,commits,files,reviews,comments';

  for (const n of targets) {
    const pr = ghJson(['pr', 'view', String(n), '--repo', repo, '--json', PR_FIELDS]);
    const names = pr.labels.map((l) => l.name);

    // The marker is what makes a pull request the pipeline's — a human or bot one is not a deviation.
    if (!names.includes(marker)) {
      note(`#${n}: not a pipeline pull request — skipped`);
      continue;
    }
    const at = (check) => `#${n} ${check}`;

    // --- Body ---
    fold(at('body'), checkPrBody(pr.body ?? ''));

    // --- Reviews --- Only pipeline reviews are checked: by the pull request's own author, or a
    // first line already trying to be a cycle heading.
    const cycles = [];
    const reviewOids = [];
    for (const r of pr.reviews) {
      const first = (lines(r.body)[0] ?? '').trim();
      const byAuthor = r.author?.login && r.author.login === pr.author?.login;
      const looksLikeOne = /code review|cycle/i.test(first);
      if (!byAuthor && !looksLikeOne) continue;
      if (byAuthor && !looksLikeOne && first === '') continue; // an empty drive-by approval

      if (!first.startsWith(REVIEW_PREFIX)) {
        auditFail(at('review'), `body must start with the literal '${REVIEW_PREFIX}' — the cockpit counts it to derive the cycle — got ${JSON.stringify(first)}`);
        continue;
      }
      const result = checkReview(JSON.stringify({ event: 'COMMENT', body: r.body, comments: [] }));
      fold(at('review'), result);
      if (!result.ok) continue;

      const m = REVIEW_HEADING.exec(first);
      cycles.push(Number(m[1]));
      if (r.commit?.oid) reviewOids.push(r.commit.oid);
    }
    if (cycles.length > 0) {
      const sorted = [...cycles].sort((a, b) => a - b);
      const expected = sorted.map((_, i) => i + 1);
      if (sorted.join(',') !== expected.join(',')) auditFail(at('review'), `cycle numbers must run 1..${cycles.length} with no gaps or duplicates, got ${sorted.join(', ')}`);
      else auditOk();
    }

    // --- Zero-diff review bounce --- A `## Gate cleared` exception authorizes one repeat
    // review on the same commit.oid; three or more means the gate was bypassed.
    {
      const byOid = new Map();
      for (const oid of reviewOids) byOid.set(oid, (byOid.get(oid) ?? 0) + 1);
      for (const [oid, count] of byOid) {
        if (count >= 3) {
          auditFail(at('review'), `${count} reviews share commit ${oid} — the zero-diff gate should stop at one authorized repeat`);
        } else if (count === 2) {
          note(`#${n}: 2 reviews share commit ${oid} — the operator-authorized zero-diff re-review, not a failure`);
        } else {
          auditOk();
        }
      }
    }

    // --- Revision comments ---
    for (const c of pr.comments) {
      const first = (lines(c.body)[0] ?? '').trim();
      if (!first.startsWith('## Revision')) continue;
      const result = checkRevision(c.body);
      fold(at('revision'), result);
      if (!result.ok) continue;
      const m = REVISION_HEADING.exec(first);
      if (Number(m[1]) > cycles.length) {
        auditFail(at('revision'), `cycle ${m[1]} exceeds the ${cycles.length} review(s) on this pull request`);
      } else {
        auditOk();
      }
    }

    // --- Approval withdrawn / Rebase required / Changes requested --- Each is a fixed heading
    // on line 1 with a SHA below it; one loop over the registry's headings checks all three.
    const shaAnnotated = Object.entries(CHECKS).filter(([, e]) => typeof e.heading === 'string');
    for (const c of pr.comments) {
      const first = (lines(c.body)[0] ?? '').trim();
      for (const [kind, entry] of shaAnnotated) {
        if (first === entry.heading) fold(at(kind), entry.run(c.body));
      }
    }

    // --- Commits ---
    for (const c of pr.commits) {
      const subject = c.messageHeadline ?? '';
      // Merges are recognized by subject (no parent count in this API) and exempt — GitHub writes them.
      if (subject.startsWith('Merge ')) continue;
      const violations = commitViolations(`${subject}\n\n${c.messageBody ?? ''}`);
      if (violations.length === 0) auditOk();
      else for (const v of violations) auditFail(at('commit'), v.detail);
    }

    // --- Labels ---
    const present = (ns, keys) => keys.filter((k) => labelEnabled(k) && ns.includes(label(k))).map(label);
    const violation = stageViolation(present(names, PR_STAGE_KEYS), present(names, PR_REFRESH_KEYS));
    if (violation) auditFail(at('labels'), violation);
    else auditOk();
    if (pr.state === 'MERGED') {
      const unfinished = [...new Set([...present(names, IN_FLIGHT_KEYS), ...present(names, TRIGGER_KEYS)])];
      if (unfinished.length > 0) auditFail(at('labels'), `merged but still labelled ${unfinished.join(', ')} — a merged pull request is terminal`);
      else auditOk();
    }

    // --- Files ---
    const scratch = pr.files.map((f) => f.path).filter((p) => SCRATCH_PATHS.test(p));
    if (scratch.length > 0) auditFail(at('files'), `scratch paths in the diff, which must never be committed: ${scratch.join(', ')}`);
    else auditOk();

    // --- Cross-surface: the issue this closes ---
    const body = lines(pr.body ?? '');
    const closes = /^Closes #(\d+)\s*$/.exec((body[0] ?? '').trim());
    if (closes) {
      const issueNo = Number(closes[1]);
      const issue = ghJson(['issue', 'view', String(issueNo), '--repo', repo, '--json', 'body,labels']);
      const issueBody = issue.body ?? '';
      const issueNames = issue.labels.map((l) => l.name);
      const issueViolation = stageViolation(present(issueNames, ISSUE_STAGE_KEYS), []);
      if (issueViolation) auditFail(at(`labels (issue #${issueNo})`), issueViolation);
      else auditOk();
      if (!/^## Implementation Plan\s*$/m.test(issueBody)) {
        auditFail(at('cross-surface'), `issue #${issueNo} has no '## Implementation Plan' — the pull request implements a plan that is not there`);
      } else {
        auditOk();
      }
      // Both surfaces are checked at the marker's slot, never by searching the whole body —
      // the plan's first non-empty line on the issue, directly under `Closes #N` on the pull request.
      const issuePlan = lines(issueBody).slice(
        lines(issueBody).findIndex((l) => l.trim() === '## Implementation Plan') + 1,
      );
      const prBody = body.slice(1);
      const issueSlotIdx = firstNonEmptyIndex(issuePlan);
      const prSlotIdx = firstNonEmptyIndex(prBody);
      const issueMarked = issueSlotIdx !== -1 && SESSION_MARKER.test(issuePlan[issueSlotIdx].trim());
      const prMarked = prSlotIdx !== -1 && SESSION_MARKER.test(prBody[prSlotIdx].trim());
      if (issueMarked && !prMarked) {
        auditFail(at('cross-surface'), `issue #${issueNo} is marked SESSION REQUIRED but the pull request does not repeat it under 'Closes #${issueNo}'`);
      } else if (!issueMarked && prMarked) {
        auditFail(at('cross-surface'), `the pull request is marked SESSION REQUIRED but issue #${issueNo} is not`);
      } else {
        auditOk();
      }

      // The canonical rendering must appear only at the slot, in pipeline-authored text —
      // the issue's plan block, and the pull request body once `Closes #N` is excluded.
      const outsideIssue = issuePlan.some((l, i) => i !== issueSlotIdx && SESSION_MARKER.test(l.trim()));
      const outsidePr = prBody.some((l, i) => i !== prSlotIdx && SESSION_MARKER.test(l.trim()));
      if (outsideIssue) {
        auditFail(at('cross-surface'), `issue #${issueNo}'s plan renders the canonical SESSION REQUIRED marker outside its slot`);
      } else {
        auditOk();
      }
      if (outsidePr) {
        auditFail(at('cross-surface'), `the pull request renders the canonical SESSION REQUIRED marker outside its slot`);
      } else {
        auditOk();
      }

      // An operator-only testing step on the issue must reach the pull request's testing
      // plan — the human's only warning that one box is theirs alone to tick.
      const issueTesting = section(lines(issueBody), '## Testing') ?? [];
      const issueHasOperatorOnly = issueTesting.some((l) => OPERATOR_ONLY_STEP.test(l));
      if (issueHasOperatorOnly) {
        const plan = section(body, '## Testing plan') ?? [];
        const prHasOperatorOnly = plan.some((l) => OPERATOR_ONLY_STEP.test(l));
        if (!prHasOperatorOnly) {
          auditFail(at('cross-surface'), `issue #${issueNo}'s '## Testing' has an operator-only step that '## Testing plan' does not repeat`);
        } else {
          auditOk();
        }
      }
    }
  }

  // --- Parked sweep --- An item in an in-flight label may be a crashed agent, or one simply
  // still working — this layer cannot tell, so it never fails on one.
  if (sweep) {
    const PARKED_HOURS = 2;
    for (const key of IN_FLIGHT_KEYS.filter(labelEnabled)) {
      const name = label(key);
      for (const [kind, noun] of [['issue', 'issue'], ['pr', 'pull request']]) {
        const items = ghJson([
          kind, 'list', '--repo', repo, '--state', 'open',
          '--label', name, '--limit', '50', '--json', 'number,updatedAt',
        ]);
        for (const it of items) {
          const hours = Math.floor((Date.now() - Date.parse(it.updatedAt)) / 3_600_000);
          if (hours >= PARKED_HOURS) {
            note(`parked: ${noun} #${it.number} has sat in '${name}' for ${hours}h — re-apply its trigger label if no agent is running`);
          }
        }
      }
    }
  }

  for (const n of notes) console.log(`note  ${n}`);
  if (failures.length === 0) {
    console.log(`ok    ${checked} checks passed`);
    process.exit(0);
  }
  for (const f of failures) console.error(`FAIL  ${f}`);
  console.error(`\n${failures.length} failure(s), ${checked} checks run`);
  process.exit(1);
}

function main() {
  const usage = 'usage: node artifacts.mjs check <kind> <file> [--issue N] [--cycle N]\n       node artifacts.mjs audit [<pr>...] [--limit <n>]';
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === 'check') return runCheck(rest);
  if (mode === 'audit') return runAudit(rest);
  die(`unrecognized mode ${JSON.stringify(mode)}. ${usage}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
