import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson, pipelineSkillText, pipelineDocsText } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// Per-ticket dispatch cost accounting.
export default async function ({ expect, fail, ok }: Reporter) {
  const templateRel = 'plugins/port/bin/budget.mjs';
  const templatePath = join(root, templateRel);
  const templateText = readFileSync(templatePath, 'utf8');

  // --- Budget template reaches outside its contract: an adopting repository copies this
  // file alone, so it must never shell out via a POSIX-only string. ---
  {
    expect(!/\bexecSync\b/.test(templateText), 'budget-template', `${templateRel} uses execSync — every child process must use spawnSync with an explicit argv array`);
    expect(!/shell:\s*true/.test(templateText), 'budget-template', `${templateRel} passes shell: true to a child process — every call must be an explicit argv array, never a shell string`);
  }

  // --- ghGraphQL reads stdout unconditionally, one round trip, no --jq: the ledger read
  // must parse the envelope from stdout rather than trusting `gh`'s exit code, non-zero on every partial-error response. ---
  {
    const graphql = /function ghGraphQL\([\s\S]*?\n}/.exec(templateText)?.[0] ?? '';
    if (!graphql) {
      fail('budget-template', `${templateRel} no longer defines ghGraphQL — the partial-error contract has nothing to pin`);
    } else if (/if\s*\(!res\.ok\)/.test(graphql)) {
      fail('budget-template', `${templateRel}'s ghGraphQL branches on 'res.ok' — a non-zero gh exit is not evidence of no data (docs/ENGINEERING.md §4)`);
    } else expect(/parseJsonObject\(res\.stdout\)/.test(graphql), 'budget-template', `${templateRel}'s ghGraphQL must parse res.stdout regardless of exit status`);
    // The ledger read is one round trip, not a viewer query plus a comments query.
    expect(/viewer \{ login \} repository\(/.test(templateText), 'budget-template', `${templateRel} must fetch 'viewer' and the issue's comments in one aliased query, not two round trips`);
    // Matches a quoted argv entry, not the word in a comment naming it as never used.
    expect(!/['"]--jq['"]/.test(templateText), 'budget-template', `${templateRel} passes --jq to gh — it silently skips that filter on the partial-error response the ledger read exists to handle`);

    // `reset` must never truncate the session log unconditionally, discarding the wall-clock of a row whose write just failed.
    const reset = /function runReset\([\s\S]*?\n}/.exec(templateText)?.[0] ?? '';
    expect(/state === 'pending'/.test(reset), 'budget-template', `${templateRel}'s runReset must keep the rows it could not flush, not truncate the session log unconditionally`);

    // The gate commits an `open` row as it returns `allow`, so it is only correct as the last pre-dispatch check.
    expect(/runs `dispatch` last/.test(templateText), 'budget-template', `${templateRel}'s header must state that the caller runs 'dispatch' last, after every other pre-dispatch veto`);

    // The committed row must record the number the cockpit dispatched with, or `--live` can never match a review/revise dispatch.
    const dispatch = /function runDispatch\([\s\S]*?\n}/.exec(templateText)?.[0] ?? '';
    if (!/dispatchNumber = opts\.pr != null \? Number\(opts\.pr\) : issue/.test(dispatch)) {
      fail('budget-template', `${templateRel}'s runDispatch must record dispatchNumber as --pr's value when given and the ticket otherwise`);
    } else expect(/\{ issue, dispatchNumber,/.test(dispatch), 'budget-template', `${templateRel}'s runDispatch must store dispatchNumber on the session-log row alongside issue`);
  }

  const mod = await import(pathToFileURL(templatePath).href);
  const { parseLedger, renderLedger, verdict, closeRows, issueFromPrBody } = mod;
  const { formatDuration, ceilingSecondsFrom, unavailableAliases } = mod;
  const { parseSessionLog, renderSessionLog, sessionTotals, renderTickClause } = mod;

  // --- parseLedger/renderLedger round-trip a table byte-for-byte. The total line is
  // derived and deliberately excluded from the comparison. ---
  {
    const rows = [
      { stage: 'plan', model: 'opus', startedAt: '2026-09-07T14:02:31Z', seconds: 401, outcome: 'completed' },
      { stage: 'impl', model: 'sonnet', startedAt: '2026-09-07T14:19:08Z', seconds: 1448, outcome: 'completed' },
      { stage: 'review', model: 'sonnet', startedAt: '2026-09-07T15:01:44Z', seconds: 192, outcome: 'lost' },
    ];
    const rendered = renderLedger(rows, 7200);
    const parsed = parseLedger(rendered);
    expect(!(!parsed || JSON.stringify(parsed.rows) !== JSON.stringify(rows)), 'budget-roundtrip', `renderLedger → parseLedger did not round-trip: ${JSON.stringify(parsed)}`);
    // An unparseable ledger is absent, never zero.
    expect(!(parseLedger('not a ledger at all') !== null), 'budget-roundtrip', 'parseLedger accepted text with no "## Pipeline Cost" heading');
    expect(!(parseLedger('## Pipeline Cost\n\n| Stage | Model | Started (UTC) | Seconds | Outcome |\n| --- | --- | --- | --- | --- |\n| plan | opus | x | not-a-number | completed |') !== null), 'budget-roundtrip', 'parseLedger accepted a non-integer Seconds cell');
  }

  // --- verdict: exceeded at/over the ceiling, allow under it, allow when null ---
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
      expect(!(got !== want), 'budget-verdict', `verdict(${JSON.stringify(input)}) = ${got}, expected ${want}`);
    }
  }

  // --- formatDuration rolls over into hours: a wall-clock ceiling is routinely exceeded
  // past the hour, where a bare minute count reads worst. ---
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
      expect(!(got !== want), 'budget-duration', `formatDuration(${input}) = '${got}', expected '${want}'`);
    }
  }

  // --- A malformed ceiling is fatal, an absent one unbounded: '120' (string), 0, and -1 must
  // never read as "no ceiling configured" — that silently disables the rail forever. ---
  {
    const unbounded = [{}, { budget: {} }, { budget: { wallClockMinutes: null } }];
    for (const cfg of unbounded) {
      const got = ceilingSecondsFrom(cfg);
      expect(!(got.ok !== true || got.ceilingSeconds !== null), 'budget-ceiling', `ceilingSecondsFrom(${JSON.stringify(cfg)}) must be unbounded, got ${JSON.stringify(got)}`);
    }
    const good = ceilingSecondsFrom({ budget: { wallClockMinutes: 120 } });
    expect(!(good.ok !== true || good.ceilingSeconds !== 7200), 'budget-ceiling', `ceilingSecondsFrom(120) must be 7200s, got ${JSON.stringify(good)}`);
    for (const bad of ['120', 0, -1, 1.5, true, {}]) {
      const got = ceilingSecondsFrom({ budget: { wallClockMinutes: bad } });
      expect(!(got.ok !== false), 'budget-ceiling', `ceilingSecondsFrom(${JSON.stringify(bad)}) must be rejected as malformed, got ${JSON.stringify(got)}`);
    }
  }

  // --- unavailableAliases names only what errors[].path names: every other alias in the
  // same envelope is trustworthy, so a readable ledger must not become a hold. ---
  {
    const got = unavailableAliases([{ path: ['repository', 'issue'] }, { path: [] }, { message: 'no path' }]);
    expect(!(!(got instanceof Set) || got.size !== 2 || !got.has('repository') || !got.has('issue')), 'budget-graphql', `unavailableAliases did not collect exactly the named paths: ${JSON.stringify([...(got ?? [])])}`);
    expect(!(unavailableAliases(undefined).size !== 0), 'budget-graphql', 'unavailableAliases must treat a missing errors array as nothing unavailable');
  }

  // --- closeRows: lost by default, completed only when told — 'lost' must not be the only reachable outcome. ---
  {
    const startedAt = new Date(Date.now() - 5000).toISOString();
    const row = () => [{ issue: 1, stage: 'plan', model: 'opus', startedAt }];
    const { closed, stillOpen } = closeRows(row(), [], Date.now());
    expect(!(closed.length !== 1 || closed[0].outcome !== 'lost' || !(closed[0].seconds >= 4) || closed[0].state !== 'pending'), 'budget-close', `closeRows did not close, time and mark an unmatched row pending: ${JSON.stringify(closed)}`);
    expect(!(stillOpen.length !== 0), 'budget-close', 'closeRows left an unmatched row open');

    const stillLive = closeRows(row(), ['plan #1'], Date.now());
    expect(!(stillLive.closed.length !== 0 || stillLive.stillOpen.length !== 1), 'budget-close', 'closeRows closed a row whose description is in the live list');

    const graceful = closeRows(row(), [], Date.now(), ['plan #1']);
    expect(!(graceful.closed.length !== 1 || graceful.closed[0].outcome !== 'completed'), 'budget-close', `closeRows must mark a --completed row 'completed', got ${JSON.stringify(graceful.closed)}`);

    // Correlation is on the number the cockpit dispatched with, not the ticket the ledger is
    // keyed on — a review/revise row keyed on `issue` would miss the pull request's own description and close too early.
    const prRow = () => [{ issue: 188, dispatchNumber: 213, stage: 'review', model: 'sonnet', startedAt }];
    const liveByPr = closeRows(prRow(), ['review #213'], Date.now());
    expect(!(liveByPr.stillOpen.length !== 1 || liveByPr.closed.length !== 0), 'budget-close', `closeRows must keep a row live by its dispatch number, not its ticket: ${JSON.stringify(liveByPr)}`);
    // The ticket number must not match: it is not what the cockpit dispatched.
    const liveByIssue = closeRows(prRow(), ['review #188'], Date.now());
    expect(!(liveByIssue.closed.length !== 1), 'budget-close', `closeRows must not correlate a pull-request dispatch by its ticket number: ${JSON.stringify(liveByIssue)}`);
    const donePr = closeRows(prRow(), [], Date.now(), ['review #213']);
    expect(!(donePr.closed.length !== 1 || donePr.closed[0].outcome !== 'completed' || donePr.closed[0].issue !== 188), 'budget-close', `closeRows must match --completed by dispatch number while keeping the row on its ticket: ${JSON.stringify(donePr.closed)}`);
  }

  // --- The session log round-trips, and its aggregate needs no ledger, even on a tick that closed nothing. ---
  {
    // dispatchNumber round-trips too — it is the correlation key, so losing it reintroduces the ticket-keyed miss.
    const rows = [
      { issue: 7, dispatchNumber: 7, stage: 'plan', model: 'opus', startedAt: '2026-09-07T14:02:31Z', state: 'closed', seconds: 401, outcome: 'completed' },
      { issue: 7, dispatchNumber: 118, stage: 'review', model: 'sonnet', startedAt: '2026-09-07T14:19:08Z', state: 'pending', seconds: 1448, outcome: 'lost' },
    ];
    const parsed = parseSessionLog(renderSessionLog(rows));
    expect(!(JSON.stringify(parsed) !== JSON.stringify(rows)), 'budget-session', `renderSessionLog → parseSessionLog did not round-trip: ${JSON.stringify(parsed)}`);
    expect(!(parsed[1]?.dispatchNumber !== 118 || parsed[1]?.issue !== 7), 'budget-session', `the session log must keep a pull-request dispatch's number distinct from its ticket: ${JSON.stringify(parsed[1])}`);
    // A legacy four-field line still parses; an absent dispatchNumber falls back to the ticket.
    const legacy = parseSessionLog('7\tplan\topus\t2026-09-07T14:02:31Z\n');
    expect(!(legacy.length !== 1 || legacy[0].state !== 'open' || legacy[0].seconds !== 0 || legacy[0].dispatchNumber !== 7), 'budget-session', `a legacy four-field session line must read as an open row keyed on its ticket: ${JSON.stringify(legacy)}`);
    const totals = sessionTotals(rows, Date.parse('2026-09-07T15:00:00Z'));
    expect(!(totals.dispatches !== 2 || totals.seconds !== 1849), 'budget-session', `sessionTotals must sum closed and pending rows without any ledger read: ${JSON.stringify(totals)}`);
    // The session half is always producible; a no-close tick still gets a clause.
    const noClose = renderTickClause(totals, []);
    expect(!(!noClose.startsWith('**Budget:** session 2 dispatches · ') || !noClose.includes('agent wall-clock')), 'budget-session', `renderTickClause must print the session half with no tickets: ${noClose}`);
    const withTicket = renderTickClause(totals, [{ issue: 158, secondsUsed: 2041, ceilingSeconds: 7200 }]);
    expect(withTicket.includes('#158 at 34m 01s of its 120m ceiling (28%)'), 'budget-session', `renderTickClause must append the per-ticket half for a ledger it read: ${withTicket}`);
  }

  // --- issueFromPrBody extracts Closes #N, null without one — how a pull-request dispatch resolves its ticket at all. ---
  {
    expect(!(issueFromPrBody('Closes #188\n\n## Summary') !== 188), 'budget-issue-from-pr', 'issueFromPrBody did not extract #188 from a well-formed body');
    expect(!(issueFromPrBody('no closing line here') !== null), 'budget-issue-from-pr', 'issueFromPrBody returned non-null for a body with no Closes line');
  }

  // --- Schema and template carry both new keys with documented defaults. ---
  {
    const schema = readJson('schema/port.config.schema.json');
    const budgetCommand = schema.properties?.commands?.properties?.budget;
    expect(!(!budgetCommand || budgetCommand.default !== null), 'budget-schema', "schema/port.config.schema.json's commands.budget must exist with default null");
    const ceiling = schema.properties?.budget?.properties?.wallClockMinutes;
    expect(!(!ceiling || ceiling.default !== null || ceiling.minimum !== 1), 'budget-schema', "schema/port.config.schema.json's budget.wallClockMinutes must exist with default null and minimum 1");

    const template = readJson('plugins/port/templates/port.config.json');
    expect(!(template.commands?.budget !== null), 'budget-schema', "plugins/port/templates/port.config.json's commands.budget must default to null");
    expect(!(!('budget' in template) || template.budget.wallClockMinutes !== null), 'budget-schema', "plugins/port/templates/port.config.json's budget.wallClockMinutes must default to null");
  }

  // --- A zero ceiling is rejected by the invalid fixture. ---
  {
    const invalid = readJson('schema/fixtures/invalid.bad-budget.json');
    expect(!(invalid.budget?.wallClockMinutes !== 0), 'budget-fixtures', 'schema/fixtures/invalid.bad-budget.json must set budget.wallClockMinutes to 0');
  }

  // --- SKILL.md and PIPELINE.md name both config keys and the rail's phrases. ---
  {
    const skillRel = 'plugins/port/skills/pipeline/SKILL.md';
    const docsRel = 'plugins/port/docs/*.md';
    const skillText = readFileSync(join(root, skillRel), 'utf8');
    // Some phrases live in RECOVERY.md's own escalation bullet — the docs union is what this assertion must read.
    const docsText = pipelineDocsText();

    for (const key of ['commands.budget', 'budget.wallClockMinutes']) {
      expect(skillText.includes(key), 'budget-docs', `${skillRel} never names '${key}'`);
      expect(docsText.includes(key), 'budget-docs', `${docsRel} never names '${key}'`);
    }

    expect(docsText.includes('cumulative agent wall-clock'), 'budget-docs', `${docsRel} does not state the ceiling is cumulative agent wall-clock per ticket`);
    expect(skillText.includes('skip silently, say nothing'), 'budget-docs', `${skillRel} does not state commands.budget's null-means-skip-silently rule`);

    // `--completed` must never be sourced from "TaskList reports finished" — every other
    // contract here infers termination from absence, which would make `completed` unreachable.
    expect(!/--completed "<every description TaskList/.test(skillText), 'budget-docs', `${skillRel} sources --completed from TaskList, which reports live agents only — a finished agent is absent from it, so 'completed' would be unreachable`);
    expect(skillText.includes('**`--completed` never comes from `TaskList`**'), 'budget-docs', `${skillRel} must state that --completed comes from the relay loop's classification, not TaskList`);
    // This phrase lives in TICK-PROSE.md, not SKILL.md, so the skill union is what this assertion must read.
    expect(/`TaskList` reports live agents only:/.test(pipelineSkillText()), 'budget-docs', `${skillRel}'s liveness cross-check must state that TaskList reports live agents only, since every class there infers termination from absence`);

    // `Budget holds:` is the cross-tick memory, the same shape Refresh sweep's `Refreshed:` already uses.
    expect(/Budget holds:/.test(skillText), 'budget-docs', `${skillRel} must carry a 'Budget holds:' field in the tick-state template, or the second-hold dispatch has no cross-tick memory`);
    expect(!(!skillText.includes('dispatch anyway') || !/second or later consecutive hold/.test(skillText)), 'budget-docs', `${skillRel} must branch the second consecutive 'hold' on the same item into dispatching anyway`);
    expect(skillText.includes("Still can't read #158's cost ledger after two ticks"), 'budget-docs', `${skillRel} is missing the plan's second-tick UX copy for a ledger still unreadable after two ticks`);

    // The caller must also name which flag each dispatched row uses — --issue instead of --pr on a review/revise row reintroduces the same under-count.
    expect(/`--issue N` for the three issue-triggered rows.*`--pr N` for the three pull-request-triggered rows/.test(skillText), 'budget-docs', `${skillRel}'s Budget gate must name --issue vs --pr per stage row, or a caller can rebuild the R2-M1 ticket-keyed miss`);
  }
}
