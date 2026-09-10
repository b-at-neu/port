#!/usr/bin/env node
// Per-ticket dispatch cost accounting (#188) — one deterministic call whose
// stdout *is* the verdict, following the `templates/worktrees.mjs` /
// `templates/artifacts.mjs` precedent: self-contained, copied into a managed
// repository by `/port:init`, addressed through `commands.budget`.
//
// The enforced ceiling is cumulative agent wall-clock per ticket
// (`budget.wallClockMinutes`, null = unbounded). Model, dispatch count and
// outcome are recorded and reported but never enforced — nothing in the
// harness exposes turn counts or token/dollar cost to the cockpit, and the
// only source for either is the local transcript files (a later ticket's
// tier, not this one's).
//
//   reset [--offline]
//     Close every `open` row in this session's local log as `lost`, flush
//     each to its ticket's ledger, then truncate the session log. Run once
//     at cockpit startup — the truncation *is* the session scoping, exactly
//     as `.temp/dispatch-log.md` documents; no clock or session id needed.
//
//   dispatch (--issue N | --pr N) --stage <plan|impl|review|revise>
//            --model <m> [--offline]
//     Resolve the ticket, read its ledger, print the verdict
//     (`allow`|`hold`|`exceeded`) as the first stdout line, a human line
//     second, and append an `open` row to the session log only on `allow`.
//
//   sweep --live "<stage> #<n>, ..." [--offline]
//     Close every open row whose "<stage> #<n>" is absent from `--live`,
//     computing each duration from this script's own clock, updating each
//     affected ticket's ledger, and printing the tick clause. An unparseable
//     `--live` entry is reported and treated as **not** live, which closes
//     the row rather than leaving it open forever.
//
//   report --issue N [--offline]
//     Read-only: prints the ledger and the current verdict.
//
// Self-contained — no relative imports. Every path is built with node:path;
// every child process is invoked with an explicit argv array via
// node:child_process.spawnSync, never a shell string. `--offline` skips all
// GitHub I/O — reading and writing the ledger falls back to a local file
// under `.temp/`, which is what the unit tests exercise.
//
// The ledger lives on the **issue**, never the pull request — the issue is
// the only object alive from `ready` through merge, so a pull-request-scoped
// ledger would silently drop every plan and impl dispatch. Ledger writes are
// scoped to the script's own comment: it only ever updates a comment that
// both starts with `## Pipeline Cost` and was authored by `viewer`; anything
// else means create a new one. A malformed ledger is absent, never zero — an
// unreadable signal is never read as a passing one.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

/** One clear line, no stack trace. */
const die = (msg) => {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
};

// --- Process helpers ---------------------------------------------------------
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts });
  if (res.error) return { ok: false, stdout: '', stderr: String(res.error.message ?? res.error), status: null };
  return { ok: res.status === 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status };
}
const git = (args, opts) => run('git', args, opts);
const gitOut = (args, opts) => {
  const res = git(args, opts);
  return res.ok ? res.stdout.trim() : null;
};

// --- Pure functions (exported for this repository's own layer 1 checks) -----

/** Formats a non-negative second count as `<m>m <ss>s`, always two-digit
 *  seconds — the human-readable form used only on the ledger's total line
 *  and in CLI verdict text, never parsed back. */
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.trunc(totalSeconds || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${String(rem).padStart(2, '0')}s`;
}

/** `allow` when there is no ceiling, or usage is under it; `exceeded` at or
 *  over it. `hold` is never returned here — it is a caller-level state for
 *  an unreadable ledger, since this function only runs once a ledger has
 *  already parsed. */
export function verdict({ secondsUsed, ceilingSeconds }) {
  if (ceilingSeconds == null) return 'allow';
  return secondsUsed >= ceilingSeconds ? 'exceeded' : 'allow';
}

/** Parses a `## Pipeline Cost` ledger comment into `{ rows }`, or returns
 *  `null` when the table does not parse — a malformed ledger is absent,
 *  never zero. Reads only `Seconds` as a number;
 *  the total line is derived by `renderLedger` and never parsed back. */
export function parseLedger(markdown) {
  const text = markdown ?? '';
  if (!/^##\s*Pipeline Cost\s*$/m.test(text)) return null;
  const lines = text.split('\n');
  const headerIdx = lines.findIndex((l) => /^\|\s*Stage\s*\|\s*Model\s*\|\s*Started/i.test(l));
  if (headerIdx === -1) return null;
  const sep = lines[headerIdx + 1] ?? '';
  if (!/^\|[\s:-]+\|/.test(sep)) return null;
  const rows = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 5) return null;
    const [stage, model, startedAt, secondsStr, outcome] = cells;
    const seconds = Number(secondsStr);
    if (!Number.isInteger(seconds) || seconds < 0) return null;
    rows.push({ stage, model, startedAt, seconds, outcome });
  }
  return { rows };
}

/** Renders a ledger comment byte-for-byte compatible with `parseLedger` —
 *  round-tripping the row data exactly, since `Seconds` is stored as an
 *  integer for that reason. The total line is human-readable and derived
 *  fresh every render; it is never itself read back by `parseLedger`. */
export function renderLedger(rows, ceilingSeconds) {
  const header = ['## Pipeline Cost', '', '| Stage | Model | Started (UTC) | Seconds | Outcome |', '| --- | --- | --- | --- | --- |'];
  const body = rows.map((r) => `| ${r.stage} | ${r.model} | ${r.startedAt} | ${r.seconds} | ${r.outcome} |`);
  const total = rows.reduce((acc, r) => acc + r.seconds, 0);
  const noun = rows.length === 1 ? 'dispatch' : 'dispatches';
  const totalLine =
    ceilingSeconds == null
      ? `**Total:** ${rows.length} ${noun} · ${total}s (${formatDuration(total)}) — no ceiling configured`
      : `**Total:** ${rows.length} ${noun} · ${total}s (${formatDuration(total)}) of ${ceilingSeconds}s (${Math.round(ceilingSeconds / 60)}m) — ${Math.round((total / Math.max(1, ceilingSeconds)) * 100)}%`;
  return [...header, ...body, '', totalLine].join('\n');
}

/** Splits a comma-separated `--live`/`--completed`-shaped argument into
 *  well-formed `"<stage> #<n>"` descriptions and the raw entries that did
 *  not match — an unparseable entry is reported by the caller and treated
 *  as **not** live, never silently dropped. */
export function parseDescriptionList(raw) {
  const descriptions = [];
  const invalid = [];
  for (const entry of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (/^[a-z]+ #\d+$/.test(entry)) descriptions.push(entry);
    else invalid.push(entry);
  }
  return { descriptions, invalid };
}

/** Closes every open row whose `"<stage> #<issue>"` is absent from
 *  `liveDescriptions`, computing its duration from `nowMs` against the
 *  row's own `startedAt`. Every closed row is marked `lost` — this function
 *  cannot tell a graceful finish from a crash from the live list alone, and
 *  a `lost` row over-counts deliberately — biasing toward escalation rather
 *  than guessing `completed` — over a possibly-wrong graceful-finish guess. */
export function closeRows(openRows, liveDescriptions, nowMs) {
  const live = new Set(liveDescriptions);
  const closed = [];
  const stillOpen = [];
  for (const row of openRows) {
    const desc = `${row.stage} #${row.issue}`;
    if (live.has(desc)) {
      stillOpen.push(row);
      continue;
    }
    const startedMs = Date.parse(row.startedAt);
    const seconds = Number.isFinite(startedMs) ? Math.max(0, Math.round((nowMs - startedMs) / 1000)) : 0;
    closed.push({ ...row, seconds, outcome: 'lost' });
  }
  return { closed, stillOpen };
}

/** Extracts the issue number a pull request closes from the first line of
 *  its body (`Closes #N`), or `null` without one — the same grammar
 *  `templates/artifacts.mjs`'s `checkPrBody` validates. */
export function issueFromPrBody(body) {
  const first = (body ?? '').split('\n')[0]?.trim() ?? '';
  const m = /^Closes #(\d+)$/.exec(first);
  return m ? Number(m[1]) : null;
}

// --- Session log (.temp/budget-session.tsv) ----------------------------------
// One line per open dispatch: issue\tstage\tmodel\tstartedAtISO. Truncated by
// `reset`, exactly like `.temp/dispatch-log.md`'s own overwrite — the
// truncation *is* the session scoping, no clock or session id needed.
const SESSION_LOG = '.temp/budget-session.tsv';

function readSessionLog(mainRoot) {
  const path = join(mainRoot, SESSION_LOG);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [issue, stage, model, startedAt] = line.split('\t');
    if (!issue || !stage || !model || !startedAt) continue;
    rows.push({ issue: Number(issue), stage, model, startedAt });
  }
  return rows;
}

function writeSessionLog(mainRoot, rows) {
  const path = join(mainRoot, SESSION_LOG);
  mkdirSync(dirname(path), { recursive: true });
  const text = rows.map((r) => `${r.issue}\t${r.stage}\t${r.model}\t${r.startedAt}`).join('\n');
  writeFileSync(path, text.length > 0 ? `${text}\n` : '');
}

function appendSessionRow(mainRoot, row) {
  const rows = readSessionLog(mainRoot);
  rows.push(row);
  writeSessionLog(mainRoot, rows);
}

// --- Config -------------------------------------------------------------------
function readConfig(mainRoot) {
  const path = join(mainRoot, '.claude', 'port.config.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function ceilingSecondsFrom(cfg) {
  const minutes = cfg?.budget?.wallClockMinutes;
  return typeof minutes === 'number' && minutes > 0 ? minutes * 60 : null;
}

// --- Ledger storage -------------------------------------------------------------
// Offline: a local file per issue, under .temp/ — what the unit tests use.
// Online: an issue comment starting with '## Pipeline Cost', authored by
// `viewer`; the script's own comment, never anyone else's.
function offlineLedgerPath(mainRoot, issue) {
  return join(mainRoot, '.temp', `budget-ledger-${issue}.md`);
}

function readLedgerOffline(mainRoot, issue) {
  const path = offlineLedgerPath(mainRoot, issue);
  if (!existsSync(path)) return { found: false, body: null, ref: null };
  return { found: true, body: readFileSync(path, 'utf8'), ref: path };
}

function writeLedgerOffline(mainRoot, issue, body) {
  const path = offlineLedgerPath(mainRoot, issue);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return { ok: true };
}

function ghJson(args) {
  const res = run('gh', args);
  if (!res.ok) return { ok: false, error: res.stderr.trim().split('\n')[0] || `gh ${args.join(' ')} failed` };
  try {
    return { ok: true, data: JSON.parse(res.stdout) };
  } catch (e) {
    return { ok: false, error: `gh ${args.join(' ')} produced unparseable JSON: ${e.message}` };
  }
}

function viewerLogin() {
  const res = ghJson(['api', 'graphql', '-f', 'query=query { viewer { login } }']);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, login: res.data?.data?.viewer?.login ?? null };
}

function readLedgerOnline(repo, issue) {
  const [owner, name] = repo.split('/');
  const viewer = viewerLogin();
  if (!viewer.ok) return { found: false, body: null, ref: null, error: viewer.error };
  const query = `query { repository(owner: "${owner}", name: "${name}") { issue(number: ${issue}) { comments(first: 100) { nodes { id databaseId body author { login } } } } } }`;
  const res = ghJson(['api', 'graphql', '-f', `query=${query}`]);
  if (!res.ok) return { found: false, body: null, ref: null, error: res.error };
  const nodes = res.data?.data?.repository?.issue?.comments?.nodes ?? [];
  const mine = nodes.find((n) => n.body?.startsWith('## Pipeline Cost') && n.author?.login === viewer.login);
  if (!mine) return { found: false, body: null, ref: null };
  return { found: true, body: mine.body, ref: mine.databaseId };
}

/** Writes `body` to a temp file and returns its path — `gh api`'s `@<file>`
 *  field syntax is how a multi-line ledger reaches the API without shell
 *  quoting of backticks or fences. */
function writeTempBody(body) {
  const path = join(tmpdir(), `port-budget-${process.pid}-${Date.now()}.md`);
  writeFileSync(path, body);
  return path;
}

function writeLedgerOnline(repo, issue, existingRef, body) {
  const path = writeTempBody(body);
  try {
    if (existingRef != null) {
      const res = run('gh', ['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${existingRef}`, '-F', `body=@${path}`]);
      if (!res.ok) return { ok: false, error: res.stderr.trim().split('\n')[0] || 'gh api PATCH failed' };
      return { ok: true };
    }
    const res = run('gh', ['api', `repos/${repo}/issues/${issue}/comments`, '-F', `body=@${path}`]);
    if (!res.ok) return { ok: false, error: res.stderr.trim().split('\n')[0] || 'gh api POST failed' };
    return { ok: true };
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // best-effort cleanup only
    }
  }
}

function readLedger(mainRoot, repo, issue, offline) {
  return offline ? readLedgerOffline(mainRoot, issue) : readLedgerOnline(repo, issue);
}

function writeLedger(mainRoot, repo, issue, offline, existingRef, body) {
  return offline ? writeLedgerOffline(mainRoot, issue, body) : writeLedgerOnline(repo, issue, existingRef, body);
}

/** Appends `row` to `issue`'s ledger, reading first so a concurrent write
 *  never clobbers rows this script did not just produce. Returns the
 *  resulting row set on success, or `null` on an unreadable/unwritable
 *  ledger — the caller decides what that means for its own exit. */
function appendToLedger(mainRoot, repo, issue, offline, row, ceilingSeconds) {
  const existing = readLedger(mainRoot, repo, issue, offline);
  if (existing.error) return null;
  let rows = [];
  if (existing.found) {
    const parsed = parseLedger(existing.body);
    if (!parsed) return null;
    rows = parsed.rows;
  }
  rows.push(row);
  const rendered = renderLedger(rows, ceilingSeconds);
  const written = writeLedger(mainRoot, repo, issue, offline, existing.ref, rendered);
  if (!written.ok) return null;
  return rows;
}

// --- git/repo facts -------------------------------------------------------------
const configRepoRoot = (path) => gitOut(['-C', path, 'rev-parse', '--show-toplevel']);

function resolveRoot() {
  const mainRoot = configRepoRoot(process.cwd());
  if (!mainRoot) die('not a git repository (git rev-parse --show-toplevel failed).');
  return mainRoot;
}

function resolveRepoAndCeiling(mainRoot) {
  const cfg = readConfig(mainRoot);
  if (!cfg) die('.claude/port.config.json was not found, or does not parse, at the repository root — this repository is not port-managed.');
  const repo = cfg.repo;
  if (!repo) die('.claude/port.config.json declares no `repo`.');
  return { repo, ceilingSeconds: ceilingSecondsFrom(cfg) };
}

// --- CLI ----------------------------------------------------------------------
const STAGES = ['plan', 'impl', 'review', 'revise'];

function parseCommonArgs(argv, spec) {
  const opts = { offline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--offline') opts.offline = true;
    else if (spec.includes(a)) opts[a.slice(2)] = argv[++i];
    else die(`unrecognized argument '${a}'.`);
  }
  return opts;
}

function runReset(argv) {
  const opts = parseCommonArgs(argv, []);
  const mainRoot = resolveRoot();
  const { repo, ceilingSeconds } = resolveRepoAndCeiling(mainRoot);
  const open = readSessionLog(mainRoot);
  if (open.length === 0) {
    writeSessionLog(mainRoot, []);
    console.log('ok    no open dispatches to close');
    process.exit(0);
  }
  const nowMs = Date.now();
  let failed = 0;
  for (const row of open) {
    const startedMs = Date.parse(row.startedAt);
    const seconds = Number.isFinite(startedMs) ? Math.max(0, Math.round((nowMs - startedMs) / 1000)) : 0;
    const closedRow = { stage: row.stage, model: row.model, startedAt: row.startedAt, seconds, outcome: 'lost' };
    const result = appendToLedger(mainRoot, repo, row.issue, opts.offline, closedRow, ceilingSeconds);
    if (result == null) {
      failed++;
      console.error(`FAIL  #${row.issue}: could not flush its open ${row.stage} dispatch to the ledger`);
    } else {
      console.log(`ok    #${row.issue} ${row.stage} closed lost (${formatDuration(seconds)})`);
    }
  }
  writeSessionLog(mainRoot, []);
  process.exit(failed > 0 ? 1 : 0);
}

function runDispatch(argv) {
  const opts = parseCommonArgs(argv, ['--issue', '--pr', '--stage', '--model']);
  const usage = 'usage: node budget.mjs dispatch (--issue N | --pr N) --stage <plan|impl|review|revise> --model <m> [--offline]';
  if ((opts.issue == null) === (opts.pr == null)) die(`dispatch needs exactly one of --issue/--pr. ${usage}`);
  if (!STAGES.includes(opts.stage)) die(`--stage must be one of ${STAGES.join(', ')}. ${usage}`);
  if (!opts.model) die(`--model is required. ${usage}`);

  const mainRoot = resolveRoot();
  const { repo, ceilingSeconds } = resolveRepoAndCeiling(mainRoot);

  let issue;
  if (opts.issue != null) {
    issue = Number(opts.issue);
    if (!Number.isInteger(issue) || issue <= 0) die(`--issue must be a positive integer. ${usage}`);
  } else {
    const pr = Number(opts.pr);
    if (!Number.isInteger(pr) || pr <= 0) die(`--pr must be a positive integer. ${usage}`);
    if (opts.offline) die('--pr resolution needs `gh` to read the pull request body — not available with --offline.');
    const view = ghJson(['pr', 'view', String(pr), '--repo', repo, '--json', 'body']);
    if (!view.ok) die(`could not read PR #${pr}'s body: ${view.error}`);
    issue = issueFromPrBody(view.data.body ?? '');
    if (issue == null) die(`PR #${pr}'s body has no 'Closes #N' on its first line — cannot resolve its ticket.`);
  }

  const existing = readLedger(mainRoot, repo, issue, opts.offline);
  if (existing.error) {
    console.log('hold');
    console.log(`⏳ Couldn't read #${issue}'s cost ledger (${existing.error}) — holding its dispatch one tick rather than dispatching blind.`);
    process.exit(0);
  }
  let rows = [];
  if (existing.found) {
    const parsed = parseLedger(existing.body);
    if (!parsed) {
      console.log('hold');
      console.log(`⏳ #${issue}'s cost ledger comment doesn't parse as a '## Pipeline Cost' table — holding its dispatch one tick rather than dispatching blind.`);
      process.exit(0);
    }
    rows = parsed.rows;
  }
  const secondsUsed = rows.reduce((acc, r) => acc + r.seconds, 0);
  const v = verdict({ secondsUsed, ceilingSeconds });
  console.log(v);
  if (v === 'exceeded') {
    console.log(
      `⛔ #${issue} has consumed ${formatDuration(secondsUsed)} of agent wall-clock against a ${Math.round(ceilingSeconds / 60)}m ceiling — escalate instead of dispatching ${opts.stage} #${issue}.`,
    );
    process.exit(0);
  }
  console.log(
    ceilingSeconds == null
      ? `✅ #${issue} dispatch allowed — ${formatDuration(secondsUsed)} of agent wall-clock so far, no ceiling configured.`
      : `✅ #${issue} dispatch allowed — ${formatDuration(secondsUsed)} of its ${Math.round(ceilingSeconds / 60)}m ceiling used.`,
  );
  appendSessionRow(mainRoot, { issue, stage: opts.stage, model: opts.model, startedAt: new Date().toISOString() });
  process.exit(0);
}

function runSweep(argv) {
  const opts = parseCommonArgs(argv, ['--live']);
  const mainRoot = resolveRoot();
  const { repo, ceilingSeconds } = resolveRepoAndCeiling(mainRoot);
  const { descriptions, invalid } = parseDescriptionList(opts.live);
  for (const bad of invalid) {
    console.log(`note  unparseable --live entry '${bad}' — treating it as not live`);
  }
  const open = readSessionLog(mainRoot);
  const { closed, stillOpen } = closeRows(open, descriptions, Date.now());
  if (closed.length === 0) {
    console.log('note  no dispatches closed this sweep');
    process.exit(0);
  }
  let failed = 0;
  for (const row of closed) {
    const ledgerRow = { stage: row.stage, model: row.model, startedAt: row.startedAt, seconds: row.seconds, outcome: row.outcome };
    const rows = appendToLedger(mainRoot, repo, row.issue, opts.offline, ledgerRow, ceilingSeconds);
    if (rows == null) {
      failed++;
      console.error(`FAIL  #${row.issue}: could not flush its closed ${row.stage} dispatch to the ledger`);
      stillOpen.push(row); // don't lose the row if the ledger write failed
      continue;
    }
    const secondsUsed = rows.reduce((acc, r) => acc + r.seconds, 0);
    console.log(
      `closed ${row.stage} #${row.issue} · ${formatDuration(row.seconds)} · lost · total ${formatDuration(secondsUsed)}${ceilingSeconds == null ? '' : ` of ${Math.round(ceilingSeconds / 60)}m (${Math.round((secondsUsed / ceilingSeconds) * 100)}%)`}`,
    );
  }
  writeSessionLog(mainRoot, stillOpen);
  process.exit(failed > 0 ? 1 : 0);
}

function runReport(argv) {
  const opts = parseCommonArgs(argv, ['--issue']);
  const issue = Number(opts.issue);
  if (!Number.isInteger(issue) || issue <= 0) die('report needs --issue N.');
  const mainRoot = resolveRoot();
  const { repo, ceilingSeconds } = resolveRepoAndCeiling(mainRoot);
  const existing = readLedger(mainRoot, repo, issue, opts.offline);
  if (existing.error) die(`could not read #${issue}'s cost ledger: ${existing.error}`);
  let rows = [];
  if (existing.found) {
    const parsed = parseLedger(existing.body);
    if (!parsed) die(`#${issue}'s cost ledger comment doesn't parse as a '## Pipeline Cost' table.`);
    rows = parsed.rows;
  }
  console.log(renderLedger(rows, ceilingSeconds));
  const secondsUsed = rows.reduce((acc, r) => acc + r.seconds, 0);
  console.log('');
  console.log(`verdict: ${verdict({ secondsUsed, ceilingSeconds })}`);
  process.exit(0);
}

function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const usage = 'usage: node budget.mjs <reset|dispatch|sweep|report> ...';
  if (mode === 'reset') return runReset(rest);
  if (mode === 'dispatch') return runDispatch(rest);
  if (mode === 'sweep') return runSweep(rest);
  if (mode === 'report') return runReport(rest);
  die(`unrecognized mode ${JSON.stringify(mode)}. ${usage}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
