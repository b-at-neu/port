// The six assertions (#123), as pure functions over already-scanned events —
// no filesystem, no `gh`, nothing but arrays and strings, so every one is
// exercised directly by scripts/port-forensics/cases/classify.cases.json.
// scan.mjs is the only I/O; report.mjs is the only place a finding's text
// reaches the operator, and always through `excerpt` (imported, never
// reimplemented).
import { classifyRecord, pairToolResults, excerpt } from '../lib/transcript.mjs';

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// --- Item correlation --------------------------------------------------------
// The existing documented rule and no other (PIPELINE.md's worktree
// correlation, apps/desktop's own AgentRecord.itemNumber): `/#(\d+)\b/`
// against the meta sidecar's description, first match, `#0` excluded. The
// stage list is pinned against the real basenames under
// plugins/port/agents/ and against apps/desktop's own PORT_STAGE_AGENTS,
// both directions, by scripts/checks/forensics.mjs.
export const STAGE_AGENTS = ['plan-agent', 'impl-agent', 'review-agent', 'revise-agent'];

/** Matched prefix-agnostically: everything up to and including the last `:`
 *  is stripped first, since real meta sidecars carry both `port:plan-agent`
 *  and a bare `plan-agent`. `null` for a non-port agent. */
export function stageOf(agentType) {
  if (typeof agentType !== 'string') return null;
  const colonIndex = agentType.lastIndexOf(':');
  const bare = colonIndex === -1 ? agentType : agentType.slice(colonIndex + 1);
  return STAGE_AGENTS.includes(bare) ? bare : null;
}

export function itemNumberOf(description) {
  if (typeof description !== 'string') return null;
  const match = /#(\d+)\b/.exec(description);
  if (!match) return null;
  const parsed = Number(match[1]);
  return parsed === 0 ? null : parsed;
}

// --- Local copies of the two shell-syntax predicates ------------------------
// Deliberately reimplemented rather than imported from
// plugins/port/hooks/lib/command-rules.mjs — scripts/ may not depend on a
// shipped path's internals. scripts/checks/forensics.mjs pins this copy
// against the original, both directions, per docs/ENGINEERING.md §2.
function tokenize(command) {
  const tokens = [];
  let i = 0;
  while (i < command.length) {
    while (i < command.length && /\s/.test(command[i])) i++;
    if (i >= command.length) break;
    let token = '';
    while (i < command.length && !/\s/.test(command[i])) {
      const c = command[i];
      if (c === '"' || c === "'") {
        const quote = c;
        i++;
        while (i < command.length && command[i] !== quote) {
          token += command[i];
          i++;
        }
        i++;
      } else {
        token += c;
        i++;
      }
    }
    tokens.push(token);
  }
  return tokens;
}

function atCommandPosition(text, keyword) {
  const re = new RegExp(`(?:^|[\\s;&|(])${keyword}(?=[\\s;&|)]|$)`);
  return re.test(text);
}

function stripQuoted(command) {
  return command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

/** A `for`/`while`/`until` keyword and a `do` keyword, each at a shell
 *  command position, on the quote-stripped command — the #120 shape. */
export function usesShellLoop(command) {
  const stripped = stripQuoted(command);
  const hasLoopKeyword = ['for', 'while', 'until'].some((kw) => atCommandPosition(stripped, kw));
  return hasLoopKeyword && atCommandPosition(stripped, 'do');
}

/** `gh` or `git`, at a command position, on the quote-stripped command. */
export function targetsGhOrGit(command) {
  const stripped = stripQuoted(command);
  return atCommandPosition(stripped, 'gh') || atCommandPosition(stripped, 'git');
}

// --- (1) Termination class --------------------------------------------------

function isQuotaRecord(raw) {
  if (!isRecord(raw) || raw.isApiErrorMessage !== true) return false;
  const status = raw.apiErrorStatus;
  return isRecord(status) && status.error === 'rate_limit';
}

function rawText(raw) {
  if (!isRecord(raw)) return '';
  const message = raw.message;
  if (!isRecord(message)) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => isRecord(b) && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/** Derives one of `quota`/`operator-stop`/`truncated`/`terminal`/`unknown`
 *  for a single transcript's raw records, in order. There is no persisted
 *  `status: killed`/`status: failed` anywhere in the on-disk format (verified
 *  against a real session tree) — every one of these four is read from an
 *  observable record shape, and an ending this cannot place is `unknown`,
 *  named with its last record's kind, never folded into `terminal` (reads as
 *  clean) or `truncated` (reads as a crash). */
export function classifyTermination(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return { class: 'unknown', evidence: { lastKind: 'none', reason: 'empty transcript' } };
  }

  const quotaRecord = records.find(isQuotaRecord);
  if (quotaRecord) {
    const status = quotaRecord.apiErrorStatus ?? {};
    return { class: 'quota', evidence: { resetsAt: status.resetsAt ?? null, rateLimitType: status.rateLimitType ?? null } };
  }

  const interruptedRecord = records.find((r) => rawText(r).includes('Request interrupted by user'));
  if (interruptedRecord) {
    return { class: 'operator-stop', evidence: { text: excerpt(rawText(interruptedRecord)).text } };
  }

  const events = records.flatMap((r) => classifyRecord(r));
  const { emitted, paired } = pairToolResults(events);
  const last = emitted.at(-1);

  if (last === undefined) {
    return { class: 'unknown', evidence: { lastKind: 'none', reason: 'no recognizable record in this transcript' } };
  }
  if (last.kind === 'tool-call') {
    const isPaired = paired.some((p) => p.index === emitted.length - 1);
    if (!isPaired) return { class: 'truncated', evidence: { tool: last.name } };
    // A paired-but-last tool-call (the transcript ends right on the result)
    // reads the same as any other completed turn — falls through to unknown
    // below, since nothing here says whether more was coming.
    return { class: 'unknown', evidence: { lastKind: 'tool-call (paired)' } };
  }
  if (last.kind === 'assistant-text' || last.kind === 'thinking') {
    return { class: 'terminal', evidence: { text: excerpt(last.text ?? '').text } };
  }
  return { class: 'unknown', evidence: { lastKind: last.kind } };
}

// --- (2) Notification gaps --------------------------------------------------

/** Every `agentId` a session's own transcript dispatched
 *  (`toolUseResult.status === 'async_launched'`). */
function dispatchedAgentIds(sessionRecords) {
  const ids = [];
  for (const raw of sessionRecords) {
    if (!isRecord(raw)) continue;
    const result = raw.toolUseResult;
    if (isRecord(result) && result.status === 'async_launched' && typeof result.agentId === 'string') {
      ids.push(result.agentId);
    }
  }
  return ids;
}

function taskStatusRecords(sessionRecords) {
  return sessionRecords.filter((raw) => isRecord(raw) && raw.type === 'attachment' && isRecord(raw.attachment) && raw.attachment.type === 'task_status');
}

/** Fails toward `not-computable`, never toward a fabricated failure count —
 *  a session predating the `task_status` attachment type carries zero of
 *  them, and reporting every dispatch as unnotified there would be
 *  fabricated defects (docs/ENGINEERING.md's own "an absent signal is never
 *  read as a passing one" cuts both ways: it is also never read as a
 *  failing one). Requires at least one `task_status` record in the session
 *  before asserting anything. */
export function notificationGaps(sessionRecords) {
  const statusRecords = taskStatusRecords(sessionRecords);
  if (statusRecords.length === 0) {
    const dispatches = dispatchedAgentIds(sessionRecords).length;
    return { computable: false, reason: `${dispatches} dispatch(es), 0 task_status records (this session predates that attachment type, or none were dispatched)` };
  }
  const notified = new Set(statusRecords.map((r) => r.attachment.taskId).filter((id) => typeof id === 'string'));
  const gaps = dispatchedAgentIds(sessionRecords).filter((id) => !notified.has(id));
  return { computable: true, gaps };
}

// --- (3) Orphans -------------------------------------------------------------

/** `inFlightItems`: `[{ number, label }]` from a live label read.
 *  `agentSummaries`: `[{ agentId, itemNumber, class }]`, one per correlated
 *  agent transcript (`classifyTermination`'s own output, already reduced to
 *  `class`). An item is an orphan when it carries an in-flight label but no
 *  correlated agent shows a `terminal` turn — either nothing correlates to
 *  it at all, or every agent that does has already stopped
 *  (quota/operator-stop/truncated/unknown). Reports only; never writes a
 *  label. */
export function orphans(inFlightItems, agentSummaries) {
  const findings = [];
  for (const item of inFlightItems) {
    const correlated = agentSummaries.filter((a) => a.itemNumber === item.number);
    if (correlated.length === 0) {
      findings.push({ item: item.number, label: item.label, reason: 'no correlated agent transcript in this session' });
      continue;
    }
    const stillTerminal = correlated.find((a) => a.class === 'terminal');
    if (!stillTerminal) {
      const last = correlated.at(-1);
      findings.push({ item: item.number, label: item.label, agentId: last.agentId, class: last.class });
    }
  }
  return findings;
}

// --- (4)/(5) Shell loops and Bash timeouts ----------------------------------

/** `sources`: `[{ source, name, command }]` — every `Bash` tool-call across
 *  the session and every subagent transcript, `source` naming which
 *  (`'session'` or an `agentId`) so a finding is attributable. Complements
 *  the `PreToolUse` guard hook (#120): the hook prevents, this detects what
 *  the hook missed, e.g. a loop run before the hook shipped. */
export function shellLoopHits(sources) {
  const bySource = new Map();
  for (const s of sources) {
    if (s.name !== 'Bash' || typeof s.command !== 'string') continue;
    if (!usesShellLoop(s.command) || !targetsGhOrGit(s.command)) continue;
    const key = s.source;
    const row = bySource.get(key) ?? { source: key, occurrences: 0, example: excerpt(s.command).text };
    row.occurrences += 1;
    bySource.set(key, row);
  }
  return [...bySource.values()];
}

/** `sources`: `[{ source, name, resultText }]` — every paired `Bash`
 *  tool-result's text, across the session and every subagent transcript. */
export function bashTimeouts(sources) {
  const hits = [];
  for (const s of sources) {
    if (s.name !== 'Bash' || typeof s.resultText !== 'string') continue;
    if (s.resultText.includes('Command timed out after ')) {
      hits.push({ source: s.source, example: excerpt(s.resultText).text });
    }
  }
  return hits;
}

// --- (6) Blocked-after-denial -------------------------------------------------

/** `agent`: `{ agentId, description, stage, resultTexts: string[], finalAssistantText: string | null }`.
 *  A denial is a tool-result whose text opens with `port: ` — the guard
 *  hook's own `permissionDecisionReason` prefix. The contract this checks:
 *  every stage agent that hit at least one denial must open its **final**
 *  assistant turn with the literal `BLOCKED:` — never a substring anywhere,
 *  which the literal string alone matches thousands of times across the
 *  tree in prompts and prose and would pass vacuously. */
export function blockedAfterDenial(agent) {
  const denialCount = agent.resultTexts.filter((t) => typeof t === 'string' && t.startsWith('port: ')).length;
  if (denialCount === 0) return null;
  const final = (agent.finalAssistantText ?? '').trimStart();
  if (final.startsWith('BLOCKED:')) return null;
  return {
    agentId: agent.agentId,
    description: agent.description ?? null,
    stage: agent.stage ?? null,
    denialCount,
    finalExcerpt: excerpt(agent.finalAssistantText ?? '').text,
  };
}

// --- Quota classing ----------------------------------------------------------

/** Groups agents whose `classifyTermination` read `quota` by `resetsAt` —
 *  four agents hitting the same five-hour reset is one exhausted window,
 *  not four independent crashes. `agents`: `[{ agentId, class, evidence }]`. */
export function quotaClass(agents) {
  const groups = new Map();
  for (const a of agents) {
    if (a.class !== 'quota') continue;
    const key = `${a.evidence?.resetsAt ?? 'unknown'}|${a.evidence?.rateLimitType ?? 'unknown'}`;
    const row = groups.get(key) ?? { resetsAt: a.evidence?.resetsAt ?? null, rateLimitType: a.evidence?.rateLimitType ?? null, agentIds: [] };
    row.agentIds.push(a.agentId);
    groups.set(key, row);
  }
  return [...groups.values()];
}
