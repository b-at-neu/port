#!/usr/bin/env node
// Layer 2 of the testing loop: assert the pipeline's documented output formats
// against real pull requests it produced.
//
// The formats live in PIPELINE.md → "Output formats" and were asserted nowhere,
// which is the exposure this closes. The one that matters most is the review
// heading: the cockpit *counts* the literal `## Code Review` to derive the cycle
// number, so renaming it silently breaks the cycle cap and the escalating bar.
//
// This repository's own merged pull requests are the fixtures — no sandbox
// repository to maintain, no stubbed `gh` whose fidelity has to be trusted.
//
// Usage:
//   node scripts/artifacts.mjs 65          audit the named pull requests
//   node scripts/artifacts.mjs             audit the 5 most recent, plus the parked sweep
//   node scripts/artifacts.mjs --limit 10  widen the sweep
//
// NEVER add this to commands.checks — it shells out to `gh`, which a dispatched
// agent's allowlist does not grant. scripts/checks.mjs enforces that mechanically.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReporter } from './lib/report.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { fail, note, ok, report } = createReporter();

/** One clear line, no stack trace — the failure modes here are a missing `gh`,
 *  a missing login, and a missing config, none of which a trace helps with. */
const die = (msg) => {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
};

const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

// --- Configuration ----------------------------------------------------------
// Label names and the approval gate are configuration, never constants. Read
// the repository's own overrides first, then fall back to the shipped defaults.
if (!existsSync(join(root, '.claude/port.config.json'))) {
  die('.claude/port.config.json is missing — this repository is not port-managed.');
}
const cfg = readJson('.claude/port.config.json');
const repo = cfg.repo;
if (!repo) die('.claude/port.config.json declares no `repo`.');

const labelDefs = readJson('plugins/port/templates/labels.json').labels;
const def = (key) => {
  const d = labelDefs.find((l) => l.key === key);
  if (!d) die(`no label is defined for key '${key}'.`);
  return d;
};
const label = (key) => cfg.labels?.[key] ?? def(key).name;
const labelEnabled = (key) => {
  const { module } = def(key);
  return module === 'core' || cfg.modules?.[module] === true;
};

const marker = label('marker');

// --- GitHub -----------------------------------------------------------------
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

// --- Arguments --------------------------------------------------------------
const usage = 'usage: node scripts/artifacts.mjs [<pr>…] [--limit <n>]';
const argv = process.argv.slice(2);
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

const sweep = targets.length === 0;
if (sweep) {
  const recent = ghJson([
    'pr', 'list', '--repo', repo, '--state', 'all',
    '--label', marker, '--limit', String(limit), '--json', 'number',
  ]);
  if (recent.length === 0) note(`no pull requests carry '${marker}' — nothing to audit`);
  targets.push(...recent.map((p) => p.number));
}

// --- Format contracts -------------------------------------------------------
const BODY_HEADINGS = ['## Summary', '## Changes', '## Testing plan', '## Automated checks'];
const REVIEW_PREFIX = '## Code Review';
// Third verdict: `review-agent` posts this when the head commit's checks
// never concluded within the bounded wait — a timeout is a `BLOCKED:`, never
// a pass, and the heading says so rather than silently reusing one of the
// other two.
const REVIEW_HEADING = /^## Code Review — Cycle (\d+) · (approved|needs revision|blocked — checks pending)$/;
const REVISION_HEADING = /^## Revision — Cycle (\d+)$/;
const APPROVAL_WITHDRAWN_HEADING = '## Approval withdrawn';
const REBASE_REQUIRED_HEADING = '## Rebase required';
const SHA_RE = /\b[0-9a-f]{7,40}\b/;
// `fixed <ids> · skipped <ids> · <sha>`, with either segment dropped when empty
// (revise-agent.md), and an optional `· rebase: <file> (<strategy>)` after the
// sha. One of the two segments must be there — a cycle that did neither writes
// no comment at all. `check <name> · <sha>` is the check-fix-mode form: no
// threads to resolve, so no `fixed`/`skipped` segment at all. `rebase onto
// <base> · <sha>` is the rebase-only-mode form: same reasoning, the work item
// was the rebase itself.
const REVISION_OPENS = /^(?:fixed|skipped|check|rebase)\b/;
const REVISION_DETAIL = /^(?:(?:fixed\b[^·]*·\s*)?(?:skipped\b[^·]*·\s*)?[0-9a-f]{7,40}\b|check\s+\S+\s*·\s*[0-9a-f]{7,40}\b|rebase\s+onto\s+\S+\s*·\s*[0-9a-f]{7,40}\b)/;
const COMMIT_SUBJECT = /^#\d+ [a-z]/;
const SCRATCH_PATHS = /^(\.temp|\.agents)\//;
// A verification step only the operator can run, at its defined position — a
// checkbox item whose text opens with the bolded prefix. Never a bare
// substring search: a plan that merely *writes about* the prefix (this
// ticket's own does) is not a marked plan.
const OPERATOR_ONLY_STEP = /^\s*[-*]\s*\[[ xX]\]\s*\*\*operator-only\*\*/;
// The session-required marker's canonical rendering, anchored at the start of
// the (trimmed) line, reason non-empty. Detection is slot-plus-form, never a
// substring search of the whole body — see PIPELINE.md → "Detection". A plan
// that merely *discusses* the marker (this ticket's own does, three times)
// must not read as marked.
const SESSION_MARKER = /^>\s*\*\*SESSION REQUIRED:\*\*\s+\S/;

/** Pull request stage labels, at most one of which may be present. The refresh
 *  pair is excluded on purpose: a refresh leaves the other labels in place. */
const PR_STAGE_KEYS = ['readyForReview', 'reviewing', 'needsRevision', 'revising', 'approved', 'needsHuman'];
const IN_FLIGHT_KEYS = ['planning', 'inProgress', 'reviewing', 'revising', 'refreshing'];
const TRIGGER_KEYS = ['ready', 'planChangesRequested', 'planApproved', 'readyForReview', 'needsRevision', 'refreshBranch'];

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

// --- Audit ------------------------------------------------------------------
const PR_FIELDS = 'number,state,body,labels,author,commits,files,reviews,comments';

for (const n of targets) {
  const pr = ghJson(['pr', 'view', String(n), '--repo', repo, '--json', PR_FIELDS]);
  const names = pr.labels.map((l) => l.name);

  // The marker is what makes a pull request the pipeline's. Without it there is
  // nothing to hold to these formats — a human or a bot pull request is not a
  // deviation. This is also why the "marker present when approvalGate is on"
  // rule cannot be a failure here: its absence is the skip condition.
  if (!names.includes(marker)) {
    note(`#${n}: not a pipeline pull request — skipped`);
    continue;
  }
  const at = (check) => `#${n} ${check}`;

  // --- Body ---
  const body = lines(pr.body);
  const closes = /^Closes #(\d+)\s*$/.exec((body[0] ?? '').trim());
  if (!closes) {
    fail(at('body'), `first line must be 'Closes #<issue>', got ${JSON.stringify((body[0] ?? '').trim())}`);
  } else {
    ok();
  }
  for (const h of BODY_HEADINGS) {
    if (has(body, h)) ok();
    else fail(at('body'), `missing '${h}'`);
  }
  const plan = section(body, '## Testing plan');
  if (plan && !plan.some((l) => /^\s*[-*]\s*\[[ xX]\]/.test(l))) {
    fail(at('body'), "'## Testing plan' holds no '- [ ]' items — it must be a checklist a human runs");
  } else if (plan) {
    ok();
  }

  // --- Reviews ---
  // Human reviews are not held to the format, so only pipeline ones are checked:
  // by the pull request's own author (PIPELINE.md's common case, one account) or
  // by a first line that is already trying to be a cycle heading. The second
  // clause is what makes a *renamed* heading fail rather than quietly skip.
  const cycles = [];
  for (const r of pr.reviews) {
    const first = (lines(r.body)[0] ?? '').trim();
    const byAuthor = r.author?.login && r.author.login === pr.author?.login;
    const looksLikeOne = /code review|cycle/i.test(first);
    if (!byAuthor && !looksLikeOne) continue;
    if (byAuthor && !looksLikeOne && first === '') continue; // an empty drive-by approval

    if (!first.startsWith(REVIEW_PREFIX)) {
      fail(
        at('review'),
        `body must start with the literal '${REVIEW_PREFIX}' — the cockpit counts it to derive the cycle — got ${JSON.stringify(first)}`,
      );
      continue;
    }
    ok();

    const m = REVIEW_HEADING.exec(first);
    if (!m) {
      fail(
        at('review'),
        `heading must be '${REVIEW_PREFIX} — Cycle <n> · <approved|needs revision|blocked — checks pending>', got ${JSON.stringify(first)}`,
      );
      continue;
    }
    ok();
    cycles.push(Number(m[1]));

    if ((lines(r.body)[1] ?? '').trim() === '') {
      fail(at('review'), `cycle ${m[1]} has no counts line directly under its heading`);
    } else {
      ok();
    }
  }
  if (cycles.length > 0) {
    const sorted = [...cycles].sort((a, b) => a - b);
    const expected = sorted.map((_, i) => i + 1);
    if (sorted.join(',') !== expected.join(',')) {
      fail(at('review'), `cycle numbers must run 1..${cycles.length} with no gaps or duplicates, got ${sorted.join(', ')}`);
    } else {
      ok();
    }
  }

  // --- Revision comments ---
  for (const c of pr.comments) {
    const cl = lines(c.body);
    const first = (cl[0] ?? '').trim();
    if (!first.startsWith('## Revision')) continue;
    const m = REVISION_HEADING.exec(first);
    if (!m) {
      fail(at('revision'), `heading must be '## Revision — Cycle <n>', got ${JSON.stringify(first)}`);
      continue;
    }
    ok();
    const detail = firstNonEmpty(cl.slice(1)).trim();
    if (!REVISION_OPENS.test(detail) || !REVISION_DETAIL.test(detail)) {
      fail(
        at('revision'),
        `cycle ${m[1]} needs one 'fixed … · skipped … · <sha>' or 'check <name> · <sha>' line, got ${JSON.stringify(detail)}`,
      );
    } else {
      ok();
    }
    if (Number(m[1]) > cycles.length) {
      fail(at('revision'), `cycle ${m[1]} exceeds the ${cycles.length} review(s) on this pull request`);
    } else {
      ok();
    }
  }

  // --- Approval withdrawn ---
  // The cockpit's carve-out to the `<labels.approved>` never-touch rail: a
  // comment naming the check, its conclusion, its link, and the head SHA the
  // conclusion belongs to — the four facts that authorise the removal.
  for (const c of pr.comments) {
    const cl = lines(c.body);
    const first = (cl[0] ?? '').trim();
    if (first !== APPROVAL_WITHDRAWN_HEADING) continue;
    const rest = cl.slice(1).join('\n');
    if (!SHA_RE.test(rest)) {
      fail(at('approval-withdrawn'), `'${APPROVAL_WITHDRAWN_HEADING}' carries no 7-40 character hex SHA`);
      continue;
    }
    // At least one other backtick-quoted token beside the SHA itself — the
    // check name.
    const FULL_SHA = /^[0-9a-f]{7,40}$/;
    const backticked = [...rest.matchAll(/`([^`]+)`/g)].map((mm) => mm[1]);
    if (!backticked.some((b) => !FULL_SHA.test(b))) {
      fail(at('approval-withdrawn'), `'${APPROVAL_WITHDRAWN_HEADING}' names no check — only a SHA`);
    } else {
      ok();
    }
  }

  // --- Rebase required ---
  // Posted by the cockpit (dispatch gate, approved re-verify) or review-agent
  // (its own mergeability exit) whenever GitHub reports a pull request
  // conflicting with its base: names the base branch and the head SHA the
  // conflict was read against, mirroring the approval-withdrawn assertion.
  for (const c of pr.comments) {
    const cl = lines(c.body);
    const first = (cl[0] ?? '').trim();
    if (first !== REBASE_REQUIRED_HEADING) continue;
    const rest = cl.slice(1).join('\n');
    if (!SHA_RE.test(rest)) {
      fail(at('rebase-required'), `'${REBASE_REQUIRED_HEADING}' carries no 7-40 character hex SHA`);
      continue;
    }
    const FULL_SHA = /^[0-9a-f]{7,40}$/;
    const backticked = [...rest.matchAll(/`([^`]+)`/g)].map((mm) => mm[1]);
    if (!backticked.some((b) => !FULL_SHA.test(b))) {
      fail(at('rebase-required'), `'${REBASE_REQUIRED_HEADING}' names no base branch — only a SHA`);
    } else {
      ok();
    }
  }

  // --- Commits ---
  for (const c of pr.commits) {
    const subject = c.messageHeadline ?? '';
    // The commits API returns no parent count, so a merge is recognized by its
    // subject. Merges are exempt: GitHub writes them, not the pipeline.
    if (subject.startsWith('Merge ')) continue;
    if (!COMMIT_SUBJECT.test(subject)) {
      fail(at('commit'), `subject must be '#<issue> <imperative lowercase summary>', got ${JSON.stringify(subject)}`);
    } else {
      ok();
    }
    if (subject.length >= 80) {
      fail(at('commit'), `subject is ${subject.length} characters, must be under 80: ${JSON.stringify(subject)}`);
    } else {
      ok();
    }
    if (subject.endsWith('.')) {
      fail(at('commit'), `subject must not end with a period: ${JSON.stringify(subject)}`);
    } else {
      ok();
    }
    if (!/^Co-Authored-By:/im.test(c.messageBody ?? '')) {
      fail(at('commit'), `${JSON.stringify(subject)} carries no 'Co-Authored-By:' trailer`);
    } else {
      ok();
    }
  }

  // --- Labels ---
  const present = (keys) => keys.filter((k) => labelEnabled(k) && names.includes(label(k)));
  const stages = present(PR_STAGE_KEYS);
  if (stages.length > 1) {
    fail(at('labels'), `carries ${stages.length} stage labels at once: ${stages.map(label).join(', ')}`);
  } else {
    ok();
  }
  if (pr.state === 'MERGED') {
    const unfinished = [...new Set([...present(IN_FLIGHT_KEYS), ...present(TRIGGER_KEYS)])];
    if (unfinished.length > 0) {
      fail(at('labels'), `merged but still labelled ${unfinished.map(label).join(', ')} — a merged pull request is terminal`);
    } else {
      ok();
    }
  }

  // --- Files ---
  const scratch = pr.files.map((f) => f.path).filter((p) => SCRATCH_PATHS.test(p));
  if (scratch.length > 0) {
    fail(at('files'), `scratch paths in the diff, which must never be committed: ${scratch.join(', ')}`);
  } else {
    ok();
  }

  // --- Cross-surface: the issue this closes ---
  if (closes) {
    const issueNo = Number(closes[1]);
    const issue = ghJson(['issue', 'view', String(issueNo), '--repo', repo, '--json', 'body']);
    const issueBody = issue.body ?? '';
    if (!/^## Implementation Plan\s*$/m.test(issueBody)) {
      fail(at('cross-surface'), `issue #${issueNo} has no '## Implementation Plan' — the pull request implements a plan that is not there`);
    } else {
      ok();
    }
    // Both surfaces are checked at the marker's *slot*, never by searching the
    // whole body: a plan that merely writes about the marker — this ticket's
    // own does, three times — is not a marked plan. On the issue the slot is
    // the first non-empty line of the plan block, before `## Overview`; on the
    // pull request it is directly under `Closes #N`, where the cockpit reads
    // it to route stage 4.
    const issuePlan = lines(issueBody).slice(
      lines(issueBody).findIndex((l) => l.trim() === '## Implementation Plan') + 1,
    );
    const prBody = body.slice(1);
    const issueSlotIdx = firstNonEmptyIndex(issuePlan);
    const prSlotIdx = firstNonEmptyIndex(prBody);
    const issueMarked = issueSlotIdx !== -1 && SESSION_MARKER.test(issuePlan[issueSlotIdx].trim());
    const prMarked = prSlotIdx !== -1 && SESSION_MARKER.test(prBody[prSlotIdx].trim());
    if (issueMarked && !prMarked) {
      fail(at('cross-surface'), `issue #${issueNo} is marked SESSION REQUIRED but the pull request does not repeat it under 'Closes #${issueNo}'`);
    } else if (!issueMarked && prMarked) {
      fail(at('cross-surface'), `the pull request is marked SESSION REQUIRED but issue #${issueNo} is not`);
    } else {
      ok();
    }

    // The canonical rendering must appear only at the slot, in pipeline-authored
    // text. Scoped deliberately: the issue's plan block (never the human-authored
    // ticket text above it, which is not the pipeline's to constrain) and the
    // whole pull request body (all of it pipeline-authored, once `Closes #N` is
    // excluded). A rendering elsewhere would be misread as a second marker by
    // anything that ever regresses to a substring search.
    const outsideIssue = issuePlan.some((l, i) => i !== issueSlotIdx && SESSION_MARKER.test(l.trim()));
    const outsidePr = prBody.some((l, i) => i !== prSlotIdx && SESSION_MARKER.test(l.trim()));
    if (outsideIssue) {
      fail(at('cross-surface'), `issue #${issueNo}'s plan renders the canonical SESSION REQUIRED marker outside its slot`);
    } else {
      ok();
    }
    if (outsidePr) {
      fail(at('cross-surface'), `the pull request renders the canonical SESSION REQUIRED marker outside its slot`);
    } else {
      ok();
    }

    // An operator-only testing step on the issue must reach the pull
    // request's testing plan — it is the human's only warning that one box is
    // theirs alone to tick. One-directional on purpose: dropping it loses that
    // warning, while an extra one in the pull request is harmless caution.
    const issueTesting = section(lines(issueBody), '## Testing') ?? [];
    const issueHasOperatorOnly = issueTesting.some((l) => OPERATOR_ONLY_STEP.test(l));
    if (issueHasOperatorOnly) {
      const prHasOperatorOnly = (plan ?? []).some((l) => OPERATOR_ONLY_STEP.test(l));
      if (!prHasOperatorOnly) {
        fail(at('cross-surface'), `issue #${issueNo}'s '## Testing' has an operator-only step that '## Testing plan' does not repeat`);
      } else {
        ok();
      }
    }
  }
}

// --- Parked sweep -----------------------------------------------------------
// An item sitting in an in-flight label may be a crashed agent, or an agent that
// is simply still working. This layer cannot tell, so it never fails on one.
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

report();
