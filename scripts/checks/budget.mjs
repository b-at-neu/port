import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson, pipelineTickText } from '../lib/files.mjs';

// #188: per-ticket dispatch cost accounting. A new topic module rather than
// growing scripts/checks/cockpit.mjs (already at its recorded 610-line cap) —
// scripts/checks.mjs wires it in directly.
export default async function ({ fail, ok }) {
  const templateRel = 'plugins/port/templates/budget.mjs';
  const templatePath = join(root, templateRel);
  const templateText = readFileSync(templatePath, 'utf8');

  // --- Budget template is self-contained and cross-platform -------------------
  // Mirrors the artifacts.mjs / worktrees.mjs rule: an adopting repository
  // copies this file alone, so it must carry no relative import and never
  // shell out via a POSIX-only string.
  {
    const relativeImport = /\bfrom\s+['"]\.\.?\//.exec(templateText);
    if (relativeImport) {
      fail('budget-template', `${templateRel} has a relative import (${JSON.stringify(relativeImport[0])}) — it must be self-contained`);
    } else {
      ok();
    }
    if (/\bexecSync\b/.test(templateText)) {
      fail('budget-template', `${templateRel} uses execSync — every child process must use spawnSync with an explicit argv array`);
    } else {
      ok();
    }
    if (/shell:\s*true/.test(templateText)) {
      fail('budget-template', `${templateRel} passes shell: true to a child process — every call must be an explicit argv array, never a shell string`);
    } else {
      ok();
    }
  }

  // #188 (R1-M1): the ledger read must parse the envelope from stdout rather
  // than trusting `gh`'s exit code, which is non-zero on every partial-error
  // response. A `if (!res.ok) return` in the GraphQL helper is the exact
  // regression, so pin that the helper reads stdout unconditionally.
  {
    const graphql = /function ghGraphQL\([\s\S]*?\n}/.exec(templateText)?.[0] ?? '';
    if (!graphql) {
      fail('budget-template', `${templateRel} no longer defines ghGraphQL — the partial-error contract has nothing to pin`);
    } else if (/if\s*\(!res\.ok\)/.test(graphql)) {
      fail('budget-template', `${templateRel}'s ghGraphQL branches on 'res.ok' — a non-zero gh exit is not evidence of no data (docs/ENGINEERING.md §4)`);
    } else if (!/parseJsonObject\(res\.stdout\)/.test(graphql)) {
      fail('budget-template', `${templateRel}'s ghGraphQL must parse res.stdout regardless of exit status`);
    } else {
      ok();
    }
    // §6: the ledger read is one round trip, not a viewer query plus a
    // comments query.
    if (!/viewer \{ login \} repository\(/.test(templateText)) {
      fail('budget-template', `${templateRel} must fetch 'viewer' and the issue's comments in one aliased query, not two round trips`);
    } else {
      ok();
    }
    // Matches a quoted argv entry, not the word in a comment — the header
    // and ghGraphQL's docstring both name `--jq` to say it is never used.
    if (/['"]--jq['"]/.test(templateText)) {
      fail('budget-template', `${templateRel} passes --jq to gh — it silently skips that filter on the partial-error response the ledger read exists to handle`);
    } else {
      ok();
    }

    // #188 (R1-L2): `reset` used to truncate the session log unconditionally,
    // discarding the wall-clock of any row whose ledger write had just failed
    // — an under-count, i.e. a failure toward dispatch.
    const reset = /function runReset\([\s\S]*?\n}/.exec(templateText)?.[0] ?? '';
    if (!/state === 'pending'/.test(reset)) {
      fail('budget-template', `${templateRel}'s runReset must keep the rows it could not flush, not truncate the session log unconditionally`);
    } else {
      ok();
    }

    // #188 (R1-M2): the gate commits an `open` row as it returns `allow`, so
    // it is only correct as the last pre-dispatch check. Both the header
    // contract here and the cockpit's own procedure must say so.
    if (!/runs `dispatch` last/.test(templateText)) {
      fail('budget-template', `${templateRel}'s header must state that the caller runs 'dispatch' last, after every other pre-dispatch veto`);
    } else {
      ok();
    }

    // #188 (R2-M1): the row the gate commits must record the number the
    // cockpit dispatched with, or `--live` can never match a review/revise
    // dispatch. `--pr`'s value when given, the ticket otherwise.
    const dispatch = /function runDispatch\([\s\S]*?\n}/.exec(templateText)?.[0] ?? '';
    if (!/dispatchNumber = opts\.pr != null \? Number\(opts\.pr\) : issue/.test(dispatch)) {
      fail('budget-template', `${templateRel}'s runDispatch must record dispatchNumber as --pr's value when given and the ticket otherwise`);
    } else if (!/\{ issue, dispatchNumber,/.test(dispatch)) {
      fail('budget-template', `${templateRel}'s runDispatch must store dispatchNumber on the session-log row alongside issue`);
    } else {
      ok();
    }
  }

  const mod = await import(pathToFileURL(templatePath).href);
  const { parseLedger, renderLedger, verdict, closeRows, issueFromPrBody } = mod;
  const { formatDuration, ceilingSecondsFrom, unavailableAliases } = mod;
  const { parseSessionLog, renderSessionLog, sessionTotals, renderTickClause } = mod;

  // --- parseLedger/renderLedger round-trip a table byte-for-byte -------------
  // The table's row data must survive a render/parse cycle exactly — Seconds
  // is stored as an integer for precisely this reason. The total line is
  // derived and deliberately excluded from the comparison.
  {
    const rows = [
      { stage: 'plan', model: 'opus', startedAt: '2026-09-07T14:02:31Z', seconds: 401, outcome: 'completed' },
      { stage: 'impl', model: 'sonnet', startedAt: '2026-09-07T14:19:08Z', seconds: 1448, outcome: 'completed' },
      { stage: 'review', model: 'sonnet', startedAt: '2026-09-07T15:01:44Z', seconds: 192, outcome: 'lost' },
    ];
    const rendered = renderLedger(rows, 7200);
    const parsed = parseLedger(rendered);
    if (!parsed || JSON.stringify(parsed.rows) !== JSON.stringify(rows)) {
      fail('budget-roundtrip', `renderLedger → parseLedger did not round-trip: ${JSON.stringify(parsed)}`);
    } else {
      ok();
    }
    // An unparseable ledger is absent, never zero.
    if (parseLedger('not a ledger at all') !== null) {
      fail('budget-roundtrip', 'parseLedger accepted text with no "## Pipeline Cost" heading');
    } else {
      ok();
    }
    if (parseLedger('## Pipeline Cost\n\n| Stage | Model | Started (UTC) | Seconds | Outcome |\n| --- | --- | --- | --- | --- |\n| plan | opus | x | not-a-number | completed |') !== null) {
      fail('budget-roundtrip', 'parseLedger accepted a non-integer Seconds cell');
    } else {
      ok();
    }
  }

  // --- verdict: exceeded at/over the ceiling, allow under it, allow when null -
  {
    const cases = [
      [{ secondsUsed: 100, ceilingSeconds: null }, 'allow'],
      [{ secondsUsed: 0, ceilingSeconds: null }, 'allow'],
      [{ secondsUsed: 99, ceilingSeconds: 100 }, 'allow'],
      [{ secondsUsed: 100, ceilingSeconds: 100 }, 'exceeded'],
      [{ secondsUsed: 101, ceilingSeconds: 100 }, 'exceeded'],
    ];
    for (const [input, want] of cases) {
      const got = verdict(input);
      if (got !== want) fail('budget-verdict', `verdict(${JSON.stringify(input)}) = ${got}, expected ${want}`);
      else ok();
    }
  }

  // --- formatDuration rolls over into hours -----------------------------------
  // #188 (R1-L1): a wall-clock ceiling is routinely exceeded past the hour,
  // where a bare minute count ('127m 00s') reads worst.
  {
    const cases = [
      [0, '0m 00s'],
      [61, '1m 01s'],
      [3599, '59m 59s'],
      [3600, '1h 00m'],
      [7620, '2h 07m'],
    ];
    for (const [input, want] of cases) {
      const got = formatDuration(input);
      if (got !== want) fail('budget-duration', `formatDuration(${input}) = '${got}', expected '${want}'`);
      else ok();
    }
  }

  // --- A malformed ceiling is fatal, an absent one unbounded ------------------
  // #188 (R1-M4): '120' (string), 0 and -1 must never read as "no ceiling
  // configured" — that silently disables the rail forever, and nothing
  // validates a live config against the schema at runtime.
  {
    const unbounded = [{}, { budget: {} }, { budget: { wallClockMinutes: null } }];
    for (const cfg of unbounded) {
      const got = ceilingSecondsFrom(cfg);
      if (got.ok !== true || got.ceilingSeconds !== null) {
        fail('budget-ceiling', `ceilingSecondsFrom(${JSON.stringify(cfg)}) must be unbounded, got ${JSON.stringify(got)}`);
      } else {
        ok();
      }
    }
    const good = ceilingSecondsFrom({ budget: { wallClockMinutes: 120 } });
    if (good.ok !== true || good.ceilingSeconds !== 7200) {
      fail('budget-ceiling', `ceilingSecondsFrom(120) must be 7200s, got ${JSON.stringify(good)}`);
    } else {
      ok();
    }
    for (const bad of ['120', 0, -1, 1.5, true, {}]) {
      const got = ceilingSecondsFrom({ budget: { wallClockMinutes: bad } });
      if (got.ok !== false) {
        fail('budget-ceiling', `ceilingSecondsFrom(${JSON.stringify(bad)}) must be rejected as malformed, got ${JSON.stringify(got)}`);
      } else {
        ok();
      }
    }
  }

  // --- unavailableAliases names only what errors[].path names ----------------
  // #188 (R1-M1): every other alias in the same envelope is trustworthy, so a
  // partial-error response with a readable ledger must not become a hold.
  {
    const got = unavailableAliases([{ path: ['repository', 'issue'] }, { path: [] }, { message: 'no path' }]);
    if (!(got instanceof Set) || got.size !== 2 || !got.has('repository') || !got.has('issue')) {
      fail('budget-graphql', `unavailableAliases did not collect exactly the named paths: ${JSON.stringify([...(got ?? [])])}`);
    } else {
      ok();
    }
    if (unavailableAliases(undefined).size !== 0) {
      fail('budget-graphql', 'unavailableAliases must treat a missing errors array as nothing unavailable');
    } else {
      ok();
    }
  }

  // --- closeRows: lost by default, completed only when told -------------------
  // #188 (R1-L3): 'lost' used to be the only reachable outcome, so the Outcome
  // column had exactly one value and the plan's contract was unreachable.
  {
    const startedAt = new Date(Date.now() - 5000).toISOString();
    const row = () => [{ issue: 1, stage: 'plan', model: 'opus', startedAt }];
    const { closed, stillOpen } = closeRows(row(), [], Date.now());
    if (closed.length !== 1 || closed[0].outcome !== 'lost' || !(closed[0].seconds >= 4) || closed[0].state !== 'pending') {
      fail('budget-close', `closeRows did not close, time and mark an unmatched row pending: ${JSON.stringify(closed)}`);
    } else {
      ok();
    }
    if (stillOpen.length !== 0) fail('budget-close', 'closeRows left an unmatched row open');
    else ok();

    const stillLive = closeRows(row(), ['plan #1'], Date.now());
    if (stillLive.closed.length !== 0 || stillLive.stillOpen.length !== 1) {
      fail('budget-close', 'closeRows closed a row whose description is in the live list');
    } else {
      ok();
    }

    const graceful = closeRows(row(), [], Date.now(), ['plan #1']);
    if (graceful.closed.length !== 1 || graceful.closed[0].outcome !== 'completed') {
      fail('budget-close', `closeRows must mark a --completed row 'completed', got ${JSON.stringify(graceful.closed)}`);
    } else {
      ok();
    }

    // #188 (R2-M1): correlation is on the number the cockpit *dispatched*
    // with, not the ticket the ledger is keyed on. A review/revise dispatch
    // on PR #213 closing issue #188 has a row of {issue: 188,
    // dispatchNumber: 213} and TaskList reports 'review #213' — keying on
    // `issue` looked for 'review #188', missed, and closed the row as `lost`
    // on the first sweep after dispatch while the agent was still running.
    // That is a systematic under-count on half the stages.
    const prRow = () => [{ issue: 188, dispatchNumber: 213, stage: 'review', model: 'sonnet', startedAt }];
    const liveByPr = closeRows(prRow(), ['review #213'], Date.now());
    if (liveByPr.stillOpen.length !== 1 || liveByPr.closed.length !== 0) {
      fail('budget-close', `closeRows must keep a row live by its dispatch number, not its ticket: ${JSON.stringify(liveByPr)}`);
    } else {
      ok();
    }
    // The ticket number must not match: it is not what the cockpit dispatched.
    const liveByIssue = closeRows(prRow(), ['review #188'], Date.now());
    if (liveByIssue.closed.length !== 1) {
      fail('budget-close', `closeRows must not correlate a pull-request dispatch by its ticket number: ${JSON.stringify(liveByIssue)}`);
    } else {
      ok();
    }
    const donePr = closeRows(prRow(), [], Date.now(), ['review #213']);
    if (donePr.closed.length !== 1 || donePr.closed[0].outcome !== 'completed' || donePr.closed[0].issue !== 188) {
      fail('budget-close', `closeRows must match --completed by dispatch number while keeping the row on its ticket: ${JSON.stringify(donePr.closed)}`);
    } else {
      ok();
    }
  }

  // --- The session log round-trips, and its aggregate needs no ledger --------
  // #188 (R1-M3): the tick clause promised a session total that nothing
  // emitted and that was not derivable after the fact, because a closed
  // dispatch used to leave the session log entirely.
  {
    // #188 (R2-M1): dispatchNumber round-trips too — it is the correlation
    // key, so losing it across a sweep's read/write reintroduces the
    // ticket-keyed miss on every pull-request stage.
    const rows = [
      { issue: 7, dispatchNumber: 7, stage: 'plan', model: 'opus', startedAt: '2026-09-07T14:02:31Z', state: 'closed', seconds: 401, outcome: 'completed' },
      { issue: 7, dispatchNumber: 118, stage: 'review', model: 'sonnet', startedAt: '2026-09-07T14:19:08Z', state: 'pending', seconds: 1448, outcome: 'lost' },
    ];
    const parsed = parseSessionLog(renderSessionLog(rows));
    if (JSON.stringify(parsed) !== JSON.stringify(rows)) {
      fail('budget-session', `renderSessionLog → parseSessionLog did not round-trip: ${JSON.stringify(parsed)}`);
    } else {
      ok();
    }
    if (parsed[1]?.dispatchNumber !== 118 || parsed[1]?.issue !== 7) {
      fail('budget-session', `the session log must keep a pull-request dispatch's number distinct from its ticket: ${JSON.stringify(parsed[1])}`);
    } else {
      ok();
    }
    // A legacy four-field line still parses, so a session in flight survives
    // an upgrade of the script rather than losing its open rows; an absent
    // dispatchNumber falls back to the ticket, which is correct for the
    // issue-keyed stages that were the only ones it could have recorded.
    const legacy = parseSessionLog('7\tplan\topus\t2026-09-07T14:02:31Z\n');
    if (legacy.length !== 1 || legacy[0].state !== 'open' || legacy[0].seconds !== 0 || legacy[0].dispatchNumber !== 7) {
      fail('budget-session', `a legacy four-field session line must read as an open row keyed on its ticket: ${JSON.stringify(legacy)}`);
    } else {
      ok();
    }
    const totals = sessionTotals(rows, Date.parse('2026-09-07T15:00:00Z'));
    if (totals.dispatches !== 2 || totals.seconds !== 1849) {
      fail('budget-session', `sessionTotals must sum closed and pending rows without any ledger read: ${JSON.stringify(totals)}`);
    } else {
      ok();
    }
    // The session half is always producible; a no-close tick still gets a
    // clause, which is what the cockpit folds into its closing line.
    const noClose = renderTickClause(totals, []);
    if (!noClose.startsWith('**Budget:** session 2 dispatches · ') || !noClose.includes('agent wall-clock')) {
      fail('budget-session', `renderTickClause must print the session half with no tickets: ${noClose}`);
    } else {
      ok();
    }
    const withTicket = renderTickClause(totals, [{ issue: 158, secondsUsed: 2041, ceilingSeconds: 7200 }]);
    if (!withTicket.includes('#158 at 34m 01s of its 120m ceiling (28%)')) {
      fail('budget-session', `renderTickClause must append the per-ticket half for a ledger it read: ${withTicket}`);
    } else {
      ok();
    }
  }

  // --- issueFromPrBody extracts Closes #N, null without one ------------------
  {
    if (issueFromPrBody('Closes #188\n\n## Summary') !== 188) {
      fail('budget-issue-from-pr', 'issueFromPrBody did not extract #188 from a well-formed body');
    } else {
      ok();
    }
    if (issueFromPrBody('no closing line here') !== null) {
      fail('budget-issue-from-pr', 'issueFromPrBody returned non-null for a body with no Closes line');
    } else {
      ok();
    }
  }

  // --- Schema and template carry both new keys with documented defaults ------
  {
    const schema = readJson('schema/port.config.schema.json');
    const budgetCommand = schema.properties?.commands?.properties?.budget;
    if (!budgetCommand || budgetCommand.default !== null) {
      fail('budget-schema', "schema/port.config.schema.json's commands.budget must exist with default null");
    } else {
      ok();
    }
    const ceiling = schema.properties?.budget?.properties?.wallClockMinutes;
    if (!ceiling || ceiling.default !== null || ceiling.minimum !== 1) {
      fail('budget-schema', "schema/port.config.schema.json's budget.wallClockMinutes must exist with default null and minimum 1");
    } else {
      ok();
    }

    const template = readJson('plugins/port/templates/port.config.json');
    if (template.commands?.budget !== null) {
      fail('budget-schema', "plugins/port/templates/port.config.json's commands.budget must default to null");
    } else {
      ok();
    }
    if (!('budget' in template) || template.budget.wallClockMinutes !== null) {
      fail('budget-schema', "plugins/port/templates/port.config.json's budget.wallClockMinutes must default to null");
    } else {
      ok();
    }
  }

  // --- A zero ceiling is rejected by the invalid fixture ----------------------
  {
    const invalid = readJson('schema/fixtures/invalid.bad-budget.json');
    if (invalid.budget?.wallClockMinutes !== 0) {
      fail('budget-fixtures', 'schema/fixtures/invalid.bad-budget.json must set budget.wallClockMinutes to 0');
    } else {
      ok();
    }
  }

  // --- SKILL.md and PIPELINE.md name both config keys and the rail's phrases -
  {
    const skillRel = 'plugins/port/skills/pipeline/SKILL.md';
    const pipelineRel = 'plugins/port/docs/PIPELINE.md';
    const skillText = readFileSync(join(root, skillRel), 'utf8');
    const pipelineText = readFileSync(join(root, pipelineRel), 'utf8');

    for (const key of ['commands.budget', 'budget.wallClockMinutes']) {
      if (!skillText.includes(key)) fail('budget-docs', `${skillRel} never names '${key}'`);
      else ok();
      if (!pipelineText.includes(key)) fail('budget-docs', `${pipelineRel} never names '${key}'`);
      else ok();
    }

    if (!pipelineText.includes('cumulative agent wall-clock')) {
      fail('budget-docs', `${pipelineRel} does not state the ceiling is cumulative agent wall-clock per ticket`);
    } else {
      ok();
    }
    if (!skillText.includes('skip silently, say nothing')) {
      fail('budget-docs', `${skillRel} does not state commands.budget's null-means-skip-silently rule`);
    } else {
      ok();
    }

    // #188 (R2-L1): `--completed` used to be sourced from "every description
    // TaskList reports finished", which no other contract in this repository
    // says it returns — every one of them infers termination from *absence*.
    // If that were the source, `completed` would be unreachable and the
    // Outcome column would be back to one value (the R1-L3 regression).
    if (/--completed "<every description TaskList/.test(skillText)) {
      fail('budget-docs', `${skillRel} sources --completed from TaskList, which reports live agents only — a finished agent is absent from it, so 'completed' would be unreachable`);
    } else {
      ok();
    }
    if (!skillText.includes('**`--completed` never comes from `TaskList`**')) {
      fail('budget-docs', `${skillRel} must state that --completed comes from the relay loop's classification, not TaskList`);
    } else {
      ok();
    }
    // #203 moved the liveness cross-check itself into TICK-PROSE.md (followed
    // when commands.tick is null) — this phrase now lives there, not in
    // SKILL.md, so the union is what this assertion must read.
    if (!/`TaskList` reports live agents only:/.test(pipelineTickText())) {
      fail('budget-docs', `${skillRel}'s liveness cross-check must state that TaskList reports live agents only, since every class there infers termination from absence`);
    } else {
      ok();
    }

    // #188 (R3-M1): the hold fail-open could not fire — nothing recorded the
    // first hold, so the rail collapsed to hold-forever on any ledger a
    // human comment edit made unparseable. `Budget holds:` is the cross-tick
    // memory, the same shape the Refresh sweep's `Refreshed:` already uses.
    if (!/Budget holds:/.test(skillText)) {
      fail('budget-docs', `${skillRel} must carry a 'Budget holds:' field in the tick-state template, or the second-hold dispatch has no cross-tick memory`);
    } else {
      ok();
    }
    if (!skillText.includes('dispatch anyway') || !/second or later consecutive hold/.test(skillText)) {
      fail('budget-docs', `${skillRel} must branch the second consecutive 'hold' on the same item into dispatching anyway`);
    } else {
      ok();
    }
    if (!skillText.includes("Still can't read #158's cost ledger after two ticks")) {
      fail('budget-docs', `${skillRel} is missing the plan's second-tick UX copy for a ledger still unreadable after two ticks`);
    } else {
      ok();
    }

    // #188 (R3-L1): the R2-M1 correlation fix is pinned script-side
    // (budget-close, budget-session above) but the caller must also name
    // which flag each dispatched row uses — a review/revise row called with
    // --issue instead of --pr reintroduces the same under-count.
    if (!/`--issue N` for the three issue-triggered rows.*`--pr N` for the three pull-request-triggered rows/.test(skillText)) {
      fail('budget-docs', `${skillRel}'s Budget gate must name --issue vs --pr per stage row, or a caller can rebuild the R2-M1 ticket-keyed miss`);
    } else {
      ok();
    }
  }
}
