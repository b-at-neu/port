import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson } from '../lib/files.mjs';

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

  const mod = await import(pathToFileURL(templatePath).href);
  const { parseLedger, renderLedger, verdict, closeRows, issueFromPrBody } = mod;

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

  // --- closeRows: a lost row's seconds are counted ----------------------------
  {
    const startedAt = new Date(Date.now() - 5000).toISOString();
    const { closed, stillOpen } = closeRows([{ issue: 1, stage: 'plan', model: 'opus', startedAt }], [], Date.now());
    if (closed.length !== 1 || closed[0].outcome !== 'lost' || !(closed[0].seconds >= 4)) {
      fail('budget-close', `closeRows did not close and time an unmatched row: ${JSON.stringify(closed)}`);
    } else {
      ok();
    }
    if (stillOpen.length !== 0) fail('budget-close', 'closeRows left an unmatched row open');
    else ok();

    const stillLive = closeRows([{ issue: 1, stage: 'plan', model: 'opus', startedAt }], ['plan #1'], Date.now());
    if (stillLive.closed.length !== 0 || stillLive.stillOpen.length !== 1) {
      fail('budget-close', 'closeRows closed a row whose description is in the live list');
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
  }
}
