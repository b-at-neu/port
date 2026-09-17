import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson, walk, relOf } from '../lib/files.mjs';

const TICK_DIR = 'scripts/port-tick';

async function importEngine(rel) {
  return import(pathToFileURL(join(root, rel)).href);
}

export default async function ({ fail, note, ok }) {
  // --- Every decision case resolves, and the table covers all eight families
  // guard(#203): a second implementation (apps/desktop's, when issue 105
  // converges) silently diverging from the engine's own recorded behaviour.
  {
    const families = {
      'envelope.cases.json': 'envelope.mjs',
      'ownership.cases.json': 'classify.mjs',
      'classify.cases.json': 'classify.mjs',
      'contention.cases.json': 'contention.mjs',
      'gates.cases.json': 'gates.mjs',
      'liveness.cases.json': 'liveness.mjs',
      'pacing.cases.json': 'pacing.mjs',
      'writes.cases.json': 'writes.mjs',
    };
    const casesDir = join(root, TICK_DIR, 'cases');
    const present = walk(casesDir).map((f) => relOf(f).split('/').pop());
    for (const file of Object.keys(families)) {
      if (!present.includes(file)) fail('tick-cases', `${TICK_DIR}/cases/${file} is missing — the eight decision families must all have a case table`);
      else ok();
    }

    const modules = {};
    for (const rel of new Set(Object.values(families))) {
      modules[rel] = await importEngine(`${TICK_DIR}/${rel}`);
    }

    const engine = {
      classifyEnvelope: modules['envelope.mjs'].classifyEnvelope,
      partitionOwnership: modules['classify.mjs'].partitionOwnership,
      issueSessionRequiredReason: modules['classify.mjs'].issueSessionRequiredReason,
      prSessionRequiredReason: modules['classify.mjs'].prSessionRequiredReason,
      parseFilesBlock: modules['contention.mjs'].parseFilesBlock,
      gateCandidates: modules['contention.mjs'].gateCandidates,
      mergeabilityRoute: modules['gates.mjs'].mergeabilityRoute,
      refreshDecision: modules['gates.mjs'].refreshDecision,
      capRefreshes: modules['gates.mjs'].capRefreshes,
      zeroDiffGate: modules['gates.mjs'].zeroDiffGate,
      cycleCapExceeded: modules['gates.mjs'].cycleCapExceeded,
      approvedReverify: modules['gates.mjs'].approvedReverify,
      refreshWins: modules['gates.mjs'].refreshWins,
      classifyUnmatched: modules['liveness.mjs'].classifyUnmatched,
      nextDelay: modules['pacing.mjs'].nextDelay,
      refreshSweepWrite: modules['writes.mjs'].refreshSweepWrite,
      zeroDiffWrite: modules['writes.mjs'].zeroDiffWrite,
      cycleCapWrite: modules['writes.mjs'].cycleCapWrite,
      approvalWithdrawnWrite: modules['writes.mjs'].approvalWithdrawnWrite,
      livenessResetWrite: modules['writes.mjs'].livenessResetWrite,
      gateResolveWrite: modules['writes.mjs'].gateResolveWrite,
    };

    for (const [file] of Object.entries(families)) {
      const table = readJson(`${TICK_DIR}/cases/${file}`);
      for (const c of table.cases) {
        const fn = c.function ?? table.function;
        const impl = engine[fn];
        if (!impl) {
          fail('tick-cases', `${file}: case '${c.name}' names unknown function '${fn}'`);
          continue;
        }
        const got = runCase(fn, impl, c.input);
        const gotStr = JSON.stringify(got);
        const expStr = JSON.stringify(c.expected);
        if (gotStr !== expStr) {
          fail('tick-cases', `${file} — '${c.name}': expected ${expStr}, got ${gotStr}`);
        } else {
          ok();
        }
      }
    }
  }

  // --- No mutating gh (or git) subcommand under the engine --------------------
  // guard(#203): the tick engine silently gaining a write path the model
  // can no longer audit. The engine is read-only against GitHub, enforced
  // mechanically: gh.mjs's one call is `gh api graphql`, and nothing under
  // scripts/port-tick/ (nor scripts/port-tick.mjs itself) may spawn a
  // mutating gh/git call — every write is emitted as a `writes` string for
  // the model to run.
  {
    // Read-only against GitHub: only gh.mjs may spawn 'gh' at all (git is
    // fine anywhere — port-tick.mjs's own repoRoot() reads it — the rail is
    // specifically "no mutating gh subcommand under the engine"), and its
    // one call must be 'gh api graphql', never an editing subcommand.
    const files = [join(root, 'scripts/port-tick.mjs'), ...walk(join(root, TICK_DIR)).filter((f) => f.endsWith('.mjs'))];
    const ghSpawnRe = /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\(\s*['"]gh['"]/;
    const allowedCall = join(root, TICK_DIR, 'gh.mjs');
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (ghSpawnRe.test(text) && f !== allowedCall) {
        fail('tick-readonly', `${relOf(f)} spawns 'gh' directly — every write must be emitted as a 'writes' string, never issued by the engine itself`);
      } else {
        ok();
      }
    }
    const ghText = readFileSync(allowedCall, 'utf8');
    const mutatingGhRe = /\bgh['"]?,\s*\[\s*['"](issue|pr|label)['"]\s*,\s*['"](?!api\b)(edit|comment|create|merge|close)['"]/;
    if (!ghText.includes("'api'") || !ghText.includes("'graphql'")) {
      fail('tick-readonly', `${TICK_DIR}/gh.mjs must call 'gh api graphql', not a different subcommand`);
    } else if (mutatingGhRe.test(ghText)) {
      fail('tick-readonly', `${TICK_DIR}/gh.mjs appears to call a mutating gh subcommand — its one call must be 'gh api graphql'`);
    } else {
      ok();
    }
  }

  // --- Defaults table matches labels.json, both directions --------------------
  // guard(#203): the engine's label vocabulary drifting from the template
  // it must resolve against.
  {
    const labelsJson = readJson('plugins/port/templates/labels.json');
    const { LABEL_DEFAULTS, LABEL_ROLES } = await importEngine(`${TICK_DIR}/config.mjs`);
    const jsonKeys = new Set(labelsJson.labels.map((l) => l.key));
    const engineKeys = new Set(Object.keys(LABEL_DEFAULTS));

    for (const l of labelsJson.labels) {
      if (LABEL_DEFAULTS[l.key] !== l.name) {
        fail('tick-labels', `config.mjs's LABEL_DEFAULTS.${l.key} is '${LABEL_DEFAULTS[l.key]}', labels.json says '${l.name}'`);
      } else {
        ok();
      }
      if (LABEL_ROLES[l.key] !== l.role) {
        fail('tick-labels', `config.mjs's LABEL_ROLES.${l.key} is '${LABEL_ROLES[l.key]}', labels.json says '${l.role}'`);
      } else {
        ok();
      }
    }
    for (const key of engineKeys) {
      if (!jsonKeys.has(key)) fail('tick-labels', `config.mjs's LABEL_DEFAULTS names '${key}', which labels.json does not carry at all`);
      else ok();
    }
  }

  // --- Ladder constants are literal, and wakeup is never null on a non-draining
  // guard(#203): a non-draining tick reaching ScheduleWakeup with nothing to
  // pass — the model reads plan/commit's 'wakeup' field directly, so a null
  // here would leave it with nothing.
  {
    const text = readFileSync(join(root, TICK_DIR, 'pacing.mjs'), 'utf8');
    for (const n of ['270', '540', '1080', '1800']) {
      if (!text.includes(n)) fail('tick-pacing', `pacing.mjs is missing the ladder constant '${n}'`);
      else ok();
    }
    const { nextDelay } = await importEngine(`${TICK_DIR}/pacing.mjs`);
    for (const step of [0, 1, 2, 3]) {
      const result = nextDelay(step, { willMoveWithoutHuman: false, observedChange: false });
      if (typeof result.delay !== 'number') fail('tick-pacing', `nextDelay(${step}, ...) returned a non-numeric delay: ${JSON.stringify(result)}`);
      else ok();
    }
  }

  // --- No --jq, no search, no shell:true, no execSync under the engine -------
  // guard(#203): the tick engine silently gaining a filtered or degraded
  // read the model can no longer audit.
  {
    const files = [join(root, 'scripts/port-tick.mjs'), ...walk(join(root, TICK_DIR)).filter((f) => f.endsWith('.mjs'))];
    for (const f of files) {
      const rel = relOf(f);
      // Strip comment-only lines first — this file's own docstrings name
      // every forbidden call as a disclaimer, which must not trip the check.
      const text = readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*)/.test(l))
        .join('\n');
      if (/--jq\b/.test(text)) fail('tick-io', `${rel} uses --jq — a GraphQL call must always be parsed in full, never filtered`);
      else ok();
      if (/\bexecSync\b/.test(text)) fail('tick-io', `${rel} uses execSync — every child process must use an explicit argv array (execFileSync/spawnSync)`);
      else ok();
      if (/shell:\s*true/.test(text)) fail('tick-io', `${rel} passes shell: true to a child process`);
      else ok();
      if (/--search\b/.test(text)) fail('tick-io', `${rel} uses gh's --search — the engine reads from the one collapsed query, never a second search call`);
      else ok();
    }
  }

  // --- Write composition lives only in writes.mjs (#225) ----------------------
  // guard(#225): the write-composition layer drifting back into the
  // orchestrator, which is exactly where the additive-vs-swap refresh-write
  // bug lived with nothing to catch it.
  // The additive-vs-swap bug this ticket fixes lived in port-tick.mjs's own
  // inline `gh ... --add-label`/`--remove-label` template literals — the one
  // layer with no case table. This keeps every future label write inside the
  // module the eighth family actually tests, instead of drifting back into
  // the orchestrator the way this one did.
  {
    const writesPath = join(root, TICK_DIR, 'writes.mjs');
    const files = [join(root, 'scripts/port-tick.mjs'), ...walk(join(root, TICK_DIR)).filter((f) => f.endsWith('.mjs') && f !== writesPath)];
    for (const f of files) {
      const rel = relOf(f);
      const text = readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*)/.test(l))
        .join('\n');
      if (/--add-label\b/.test(text)) fail('tick-writes', `${rel} composes '--add-label' inline — every gh label write must go through writes.mjs's exported functions`);
      else ok();
      if (/--remove-label\b/.test(text)) fail('tick-writes', `${rel} composes '--remove-label' inline — every gh label write must go through writes.mjs's exported functions`);
      else ok();
      if (/\bgh (issue|pr) edit\b/.test(text)) fail('tick-writes', `${rel} spells out a 'gh issue/pr edit' command literal — that composition belongs in writes.mjs alone`);
      else ok();
    }
  }

  // --- SKILL.md names tickId, the verbatim rail, and the TICK-PROSE.md fallback
  // guard(#203): the model re-deriving a decision the plan already settled,
  // with nothing checking that it ran the script at all.
  {
    const skillRel = 'plugins/port/skills/pipeline/SKILL.md';
    const skillText = readFileSync(join(root, skillRel), 'utf8');
    for (const phrase of ['tickId', 'TICK-PROSE.md', 'commands.tick']) {
      if (!skillText.includes(phrase)) fail('tick-skill', `${skillRel} never names '${phrase}'`);
      else ok();
    }
    if (!/verbatim/i.test(skillText)) {
      fail('tick-skill', `${skillRel} never states the verbatim-execution rail`);
    } else {
      ok();
    }
  }
}

function runCase(fn, impl, input) {
  switch (fn) {
    case 'classifyEnvelope':
      return impl(input);
    case 'partitionOwnership': {
      const result = impl(input.nodes, input.viewerLogin);
      return { mine: result.mine.map((n) => n.number), others: result.others.map((n) => n.number), unowned: result.unowned.map((n) => n.number) };
    }
    case 'issueSessionRequiredReason':
    case 'prSessionRequiredReason':
      return impl(input);
    case 'parseFilesBlock':
      return impl(input);
    case 'gateCandidates': {
      const result = impl(input.candidates, input.occupiedSet, input.sharedFiles, input.threshold);
      return { dispatch: result.dispatch, heldItems: result.held.map((h) => h.item) };
    }
    case 'mergeabilityRoute':
      return impl(...input);
    case 'refreshDecision':
      return impl(...input);
    case 'capRefreshes': {
      const [candidates, max] = input;
      const result = impl(candidates, max);
      return { toRefreshNumbers: result.toRefresh.map((c) => c.number), deferredNumbers: result.deferred.map((c) => c.number) };
    }
    case 'zeroDiffGate':
      return impl(input);
    case 'cycleCapExceeded':
      return impl(...input);
    case 'approvedReverify':
      return impl(input);
    case 'refreshWins':
      return impl(input);
    case 'classifyUnmatched':
      return impl(input);
    case 'nextDelay':
      return impl(...input);
    case 'refreshSweepWrite':
    case 'zeroDiffWrite':
    case 'cycleCapWrite':
    case 'approvalWithdrawnWrite':
    case 'livenessResetWrite':
    case 'gateResolveWrite':
      return impl(input);
    default:
      throw new Error(`no case runner wired for function '${fn}'`);
  }
}
