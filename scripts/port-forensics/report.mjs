// The `report` subcommand's whole implementation (#123): argument
// validation, scanning, running the six assertions, and rendering — text in
// the same `note`/`FAIL`/`ok` shape scripts/lib/report.mjs's reporter
// already uses (so this operator tool reads identically to layers 1 and 2
// at a glance), or `--json`, from the one classifier output behind both.
// scripts/port-forensics.mjs only calls this and prints; every decision
// lives here and in classify.mjs.
import { resolveClaudeHome, buildProjectIndex, readSession, listSessionIds } from './scan.mjs';
import { classifyTermination, notificationGaps, orphans, shellLoopHits, bashTimeouts, blockedAfterDenial, quotaClass, stageOf, itemNumberOf } from './classify.mjs';
import { fetchInFlightItems } from './gh.mjs';
import { classifyRecord, pairToolResults } from '../lib/transcript.mjs';
import { loadConfig } from '../port-tick/config.mjs';

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message) {
  return { exitCode: 1, notes: [], findings: [{ kind: 'forensics', message }], checksRun: 0 };
}

/** Every `Bash` tool-call in `records`, paired with its result text when one
 *  arrived — the shared shape `shellLoopHits`/`bashTimeouts` both read,
 *  attributed to `source` (`'session'` or an agent id) so a finding names
 *  where it came from. */
function bashCallsOf(records, source) {
  const { emitted, paired } = pairToolResults(records.flatMap((r) => classifyRecord(r)));
  const pairedByIndex = new Map(paired.map((p) => [p.index, p]));
  const calls = [];
  emitted.forEach((entry, index) => {
    if (entry.kind !== 'tool-call' || entry.name !== 'Bash') return;
    const command = typeof entry.input?.command === 'string' ? entry.input.command : '';
    const result = pairedByIndex.get(index);
    calls.push({ source, name: 'Bash', command, resultText: result?.text ?? null });
  });
  return calls;
}

/** Every tool-result's text in `records`, regardless of tool name — the
 *  denial-detection input `blockedAfterDenial` needs, since a guard-hook
 *  denial can land on any tool, not only `Bash`. */
function resultTextsOf(records) {
  const { emitted, paired } = pairToolResults(records.flatMap((r) => classifyRecord(r)));
  void emitted;
  return paired.map((p) => p.text);
}

/** The last assistant-authored text or thinking entry in `records` — what
 *  `blockedAfterDenial` reads to check whether an agent that hit a denial
 *  opened its final turn with `BLOCKED:`. */
function finalAssistantTextOf(records) {
  const events = records.flatMap((r) => classifyRecord(r));
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === 'assistant-text' || events[i].kind === 'thinking') return events[i].text;
  }
  return null;
}

function sessionMaxTimestampMs(session) {
  let max = -Infinity;
  const scan = (records) => {
    for (const r of records) {
      if (typeof r?.timestamp !== 'string') continue;
      const ms = Date.parse(r.timestamp);
      if (!Number.isNaN(ms) && ms > max) max = ms;
    }
  };
  scan(session.records);
  for (const a of session.agents) scan(a.records);
  return max;
}

/** The whole `report` subcommand. `args` carries the already-split flag
 *  values (`session`, `since`, `claudeHome`, `json`); nothing here reads
 *  `process.argv`. Returns `{ exitCode, notes, findings, checksRun }` —
 *  `render*` below turns that into the printed form. Every argument is
 *  validated before any filesystem call, per the CLI contract. */
export function runReport(args = {}) {
  if (args.session !== undefined && !SESSION_ID_RE.test(args.session)) {
    return fail(`--session '${args.session}' is not a valid session id (invalid-id)`);
  }
  let sinceMs = null;
  if (args.since !== undefined) {
    sinceMs = Date.parse(args.since);
    if (Number.isNaN(sinceMs)) return fail(`--since '${args.since}' does not parse as a date`);
  }

  const claudeHome = resolveClaudeHome(args.claudeHome);
  const index = buildProjectIndex(claudeHome);
  if (!index.ok) {
    return {
      exitCode: 2,
      notes: [],
      findings: [{ kind: 'forensics', message: `${index.message} — resolved from ${args.claudeHome ? '--claude-home' : process.env.CLAUDE_CONFIG_DIR ? 'CLAUDE_CONFIG_DIR' : 'the default ~/.claude'}. Nothing was read, and this is not reported as clean.` }],
      checksRun: 0,
    };
  }

  const candidateIds = args.session ? [args.session.toLowerCase()] : listSessionIds(index.index);
  const sessionsRead = [];
  for (const id of candidateIds) {
    const projectDir = index.index.get(id);
    if (!projectDir) continue;
    sessionsRead.push(readSession(id, projectDir));
  }

  const matched = sinceMs === null ? sessionsRead : sessionsRead.filter((s) => sessionMaxTimestampMs(s) >= sinceMs);

  if (matched.length === 0) {
    const filterNote = args.since ? ` --since ${args.since}` : '';
    return {
      exitCode: 0,
      notes: [`forensics: 0 sessions matched${filterNote} (${sessionsRead.length} sessions read) — nothing to assert on.`],
      findings: [],
      checksRun: 0,
    };
  }

  // --- Run the six assertions across every matched session -----------------
  const findings = [];
  const agentSummaries = []; // flat, across every matched session — orphans/quotaClass both need the combined set
  let totalAgents = 0;
  let totalMalformed = 0;
  const notComputableNotifications = [];

  for (const session of matched) {
    totalMalformed += session.malformed;
    for (const p of session.problems) {
      findings.push({ kind: 'scan', message: `${p.path}: ${p.kind} — ${p.message}` });
    }

    const gaps = notificationGaps(session.records);
    if (!gaps.computable) {
      notComputableNotifications.push(`session ${session.sessionId} — ${gaps.reason}`);
    } else {
      for (const agentId of gaps.gaps) {
        findings.push({ kind: 'notification-gap', message: `agent-${agentId} was dispatched but produced no task-notification (session ${session.sessionId})` });
      }
    }

    const bashSources = [...bashCallsOf(session.records, 'session')];
    for (const agent of session.agents) {
      totalAgents += 1;
      totalMalformed += agent.malformed;
      bashSources.push(...bashCallsOf(agent.records, `agent-${agent.agentId}`));

      const term = classifyTermination(agent.records);
      agentSummaries.push({
        agentId: agent.agentId,
        description: agent.description,
        stage: stageOf(agent.agentType),
        itemNumber: itemNumberOf(agent.description),
        class: term.class,
        evidence: term.evidence,
      });

      if (term.class !== 'terminal') {
        findings.push({
          kind: 'termination',
          message: `agent-${agent.agentId} (${stageOf(agent.agentType) ?? agent.agentType}, ${JSON.stringify(agent.description ?? '')}) ended ${term.class} — ${JSON.stringify(term.evidence)}`,
        });
      }

      const denial = blockedAfterDenial({
        agentId: agent.agentId,
        description: agent.description,
        stage: stageOf(agent.agentType),
        resultTexts: resultTextsOf(agent.records),
        finalAssistantText: finalAssistantTextOf(agent.records),
      });
      if (denial) {
        findings.push({
          kind: 'denial-blocked',
          message: `agent-${denial.agentId} (${denial.stage ?? 'unknown stage'}, ${JSON.stringify(denial.description ?? '')}) hit ${denial.denialCount} denial(s) and its final turn does not open 'BLOCKED:' — last turn: ${JSON.stringify(denial.finalExcerpt)}`,
        });
      }
    }

    for (const hit of shellLoopHits(bashSources)) {
      findings.push({ kind: 'shell-loop', message: `session ${session.sessionId} — ${hit.source} ran gh/git inside a loop: ${JSON.stringify(hit.example)} (${hit.occurrences} occurrence(s))` });
    }
    for (const hit of bashTimeouts(bashSources)) {
      findings.push({ kind: 'bash-timeout', message: `session ${session.sessionId} — ${hit.source} hit the tool timeout: ${JSON.stringify(hit.example)}` });
    }
  }

  for (const group of quotaClass(agentSummaries)) {
    if (group.agentIds.length <= 1) continue; // a single quota hit is already named by its own termination finding
    findings.push({ kind: 'quota-class', message: `${group.agentIds.length} agents terminated quota together, resets ${group.resetsAt ?? 'unknown'} (${group.rateLimitType ?? 'unknown'}): ${group.agentIds.map((id) => `agent-${id}`).join(', ')}` });
  }

  const notes = [`forensics: ${matched.length} session(s), ${totalAgents} agent(s), ${totalMalformed} malformed line(s)`];
  for (const n of notComputableNotifications) notes.push(`notification check not computable for ${n}`);

  // The orphan assertion is the only place this engine reads GitHub, and
  // only when a repository root resolves to a loadable config — a
  // fixture-only run (no `.claude/port.config.json` at `args.repoRoot`)
  // degrades this one assertion to "not computable" rather than failing
  // the whole report (docs/ENGINEERING.md §4's fail-toward-reporting rule).
  let cfg = null;
  try {
    if (args.repoRoot) cfg = loadConfig(args.repoRoot);
  } catch {
    cfg = null;
  }
  if (cfg === null) {
    notes.push('orphan check not computable — no loadable .claude/port.config.json at the resolved repository root');
  } else {
    const inFlight = fetchInFlightItems(cfg);
    if (!inFlight.ok) {
      notes.push(`orphan check not computable — ${inFlight.error}`);
    } else {
      for (const orphan of orphans(inFlight.items, agentSummaries)) {
        findings.push({ kind: 'orphan', message: `#${orphan.item} carries '${orphan.label}' with no agent showing a terminal turn${orphan.agentId ? ` — agent-${orphan.agentId} ended ${orphan.class}` : ` — ${orphan.reason}`}` });
      }
    }
  }

  return { exitCode: findings.length === 0 ? 0 : 1, notes, findings, checksRun: matched.length };
}

export function renderText({ notes, findings, checksRun }) {
  const lines = [];
  for (const n of notes) lines.push(`note  ${n}`);
  if (findings.length === 0) {
    if (checksRun > 0) lines.push(`ok    ${checksRun} checks passed`);
    return lines.join('\n');
  }
  for (const f of findings) lines.push(`FAIL  ${f.kind}: ${f.message}`);
  // The single synthetic `forensics`-kind finding from a malformed argument
  // (exit 1) or an unreadable session tree (exit 2) is a bare `FAIL` line
  // with no trailing count, per the plan's "Could not read" sample — those
  // paths never ran a check, so a count line would misreport 0 as a tally.
  const isSyntheticFailure = findings.length === 1 && findings[0].kind === 'forensics' && checksRun === 0;
  if (!isSyntheticFailure) lines.push('', `${findings.length} failure(s), ${checksRun} checks run`);
  return lines.join('\n');
}

export function renderJson({ notes, findings }) {
  return { notes, findings };
}
