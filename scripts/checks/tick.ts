import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson, walk, relOf, pipelineSkillText } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

const TICK_DIR = 'scripts/port-tick';

async function importEngine(rel: string): Promise<any> {
  return import(pathToFileURL(join(root, rel)).href);
}

export default async function ({ fail, note, ok }: Reporter) {
  // --- Every decision case resolves, and the table covers all eleven families
  // guard(#203): a second implementation (apps/desktop's, when issue 105
  // converges) silently diverging from the engine's own recorded behaviour.
  // #187 adds three families for the trajectory record: events, denials,
  // report.
  // pin: `scripts/port-tick/cases/*.json` ↔ every pure function in `scripts/port-tick/` it names
  {
    const families: Record<string, string> = {
      'envelope.cases.json': 'envelope.ts',
      'ownership.cases.json': 'classify.ts',
      'classify.cases.json': 'classify.ts',
      'contention.cases.json': 'contention.ts',
      'gates.cases.json': 'gates.ts',
      'liveness.cases.json': 'liveness.ts',
      'pacing.cases.json': 'pacing.ts',
      'writes.cases.json': 'writes.ts',
      'events.cases.json': 'events.ts',
      'denials.cases.json': 'denials.ts',
      'report.cases.json': 'report.ts',
    };
    const casesDir = join(root, TICK_DIR, 'cases');
    const present = walk(casesDir).map((f) => relOf(f).split('/').pop());
    for (const file of Object.keys(families)) {
      if (!present.includes(file)) fail('tick-cases', `${TICK_DIR}/cases/${file} is missing — the eleven decision families must all have a case table`);
      else ok();
    }

    const modules: Record<string, any> = {};
    for (const rel of new Set(Object.values(families))) {
      modules[rel] = await importEngine(`${TICK_DIR}/${rel}`);
    }

    const engine: Record<string, any> = {
      classifyEnvelope: modules['envelope.ts'].classifyEnvelope,
      partitionOwnership: modules['classify.ts'].partitionOwnership,
      issueSessionRequiredReason: modules['classify.ts'].issueSessionRequiredReason,
      prSessionRequiredReason: modules['classify.ts'].prSessionRequiredReason,
      parseFilesBlock: modules['contention.ts'].parseFilesBlock,
      gateCandidates: modules['contention.ts'].gateCandidates,
      mergeabilityRoute: modules['gates.ts'].mergeabilityRoute,
      refreshDecision: modules['gates.ts'].refreshDecision,
      capRefreshes: modules['gates.ts'].capRefreshes,
      zeroDiffGate: modules['gates.ts'].zeroDiffGate,
      cycleCapExceeded: modules['gates.ts'].cycleCapExceeded,
      approvedReverify: modules['gates.ts'].approvedReverify,
      refreshWins: modules['gates.ts'].refreshWins,
      classifyUnmatched: modules['liveness.ts'].classifyUnmatched,
      nextDelay: modules['pacing.ts'].nextDelay,
      refreshSweepWrite: modules['writes.ts'].refreshSweepWrite,
      zeroDiffWrite: modules['writes.ts'].zeroDiffWrite,
      cycleCapWrite: modules['writes.ts'].cycleCapWrite,
      approvalWithdrawnWrite: modules['writes.ts'].approvalWithdrawnWrite,
      livenessResetWrite: modules['writes.ts'].livenessResetWrite,
      gateResolveWrite: modules['writes.ts'].gateResolveWrite,
      formatEvent: modules['events.ts'].formatEvent,
      rotationDecision: modules['events.ts'].rotationDecision,
      parseDenialLine: modules['denials.ts'].parseDenialLine,
      summarizeDelta: modules['denials.ts'].summarizeDelta,
      findGaps: modules['report.ts'].findGaps,
      deriveSpans: modules['report.ts'].deriveSpans,
      aggregate: modules['report.ts'].aggregate,
      renderText: modules['report.ts'].renderText,
    };

    for (const [file] of Object.entries(families)) {
      const table = readJson(`${TICK_DIR}/cases/${file}`);
      for (const c of table.cases) {
        const fn: string = c.function ?? table.function;
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
  // mechanically: gh.ts's one call is `gh api graphql`, and nothing under
  // scripts/port-tick/ (nor scripts/port-tick.ts itself) may spawn a
  // mutating gh/git call — every write is emitted as a `writes` string for
  // the model to run.
  {
    // Read-only against GitHub: only gh.ts may spawn 'gh' at all (git is
    // fine anywhere — port-tick.ts's own repoRoot() reads it — the rail is
    // specifically "no mutating gh subcommand under the engine"), and its
    // one call must be 'gh api graphql', never an editing subcommand.
    const engineFiles = walk(join(root, TICK_DIR)).filter((f) => f.endsWith('.ts'));
    if (engineFiles.length === 0) fail('tick-readonly', `${TICK_DIR}/*.ts matched zero files — the read-only scan itself is broken`);
    else ok();
    const files = [join(root, 'scripts/port-tick.ts'), ...engineFiles];
    const ghSpawnRe = /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\(\s*['"]gh['"]/;
    const allowedCall = join(root, TICK_DIR, 'gh.ts');
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
      fail('tick-readonly', `${TICK_DIR}/gh.ts must call 'gh api graphql', not a different subcommand`);
    } else if (mutatingGhRe.test(ghText)) {
      fail('tick-readonly', `${TICK_DIR}/gh.ts appears to call a mutating gh subcommand — its one call must be 'gh api graphql'`);
    } else {
      ok();
    }
  }

  // --- Defaults table matches labels.json, both directions --------------------
  // guard(#203): the engine's label vocabulary drifting from the template
  // it must resolve against.
  // pin: `scripts/port-tick/config.ts`'s `LABEL_DEFAULTS`/`LABEL_ROLES` ↔ `data/labels.json`
  {
    const labelsJson = readJson('plugins/port/data/labels.json');
    const { LABEL_DEFAULTS, LABEL_ROLES, LABEL_SURFACE } = await importEngine(`${TICK_DIR}/config.ts`);
    const jsonKeys = new Set(labelsJson.labels.map((l: any) => l.key));
    const engineKeys = new Set(Object.keys(LABEL_DEFAULTS));

    for (const l of labelsJson.labels) {
      if (LABEL_DEFAULTS[l.key] !== l.name) {
        fail('tick-labels', `config.ts's LABEL_DEFAULTS.${l.key} is '${LABEL_DEFAULTS[l.key]}', labels.json says '${l.name}'`);
      } else {
        ok();
      }
      if (LABEL_ROLES[l.key] !== l.role) {
        fail('tick-labels', `config.ts's LABEL_ROLES.${l.key} is '${LABEL_ROLES[l.key]}', labels.json says '${l.role}'`);
      } else {
        ok();
      }
    }
    for (const key of engineKeys) {
      if (!jsonKeys.has(key)) fail('tick-labels', `config.ts's LABEL_DEFAULTS names '${key}', which labels.json does not carry at all`);
      else ok();
    }

    // --- LABEL_SURFACE covers exactly the same key set, both directions
    // guard(#236): a label key silently missing a surface, so a write for
    // it falls through to no target at all rather than a wrongly-guessed
    // one — a key LABEL_DEFAULTS carries but LABEL_SURFACE omits is the
    // exact shape of the original bug, so this pin makes a missing key a
    // layer-1 failure instead of a runtime default.
    const surfaceKeys = new Set(Object.keys(LABEL_SURFACE));
    for (const key of engineKeys) {
      if (!surfaceKeys.has(key)) fail('tick-labels', `config.ts's LABEL_SURFACE is missing key '${key}', which LABEL_DEFAULTS carries`);
      else ok();
    }
    for (const key of surfaceKeys) {
      if (!engineKeys.has(key)) fail('tick-labels', `config.ts's LABEL_SURFACE names '${key}', which LABEL_DEFAULTS does not carry`);
      else ok();
    }
    const bothKeys: string[] = [];
    for (const [key, value] of Object.entries<string>(LABEL_SURFACE)) {
      if (!['issue', 'pr', 'both'].includes(value)) {
        fail('tick-labels', `config.ts's LABEL_SURFACE.${key} is '${value}', must be 'issue', 'pr', or 'both'`);
      } else {
        ok();
      }
      if (value === 'both') bothKeys.push(key);
    }
    const expectedBoth = new Set(['marker']);
    if (bothKeys.length !== expectedBoth.size || !bothKeys.every((k) => expectedBoth.has(k))) {
      fail('tick-labels', `config.ts's LABEL_SURFACE 'both' entries are [${bothKeys.join(', ')}], expected exactly [marker]`);
    } else {
      ok();
    }
  }

  // --- LABEL_SURFACE pinned against query.ts's issueSet/prSet call sites, and the cross-surface/no-target-literal rails (#236) ---
  // pin: `scripts/port-tick/config.ts`'s `LABEL_SURFACE` ↔ `query.ts`'s `issueSet`/`prSet` call sites
  {
    const { LABEL_SURFACE } = await importEngine(`${TICK_DIR}/config.ts`);
    const { RETRY_TRIGGER } = await importEngine(`${TICK_DIR}/liveness.ts`);
    const queryText = readFileSync(join(root, TICK_DIR, 'query.ts'), 'utf8');

    // query.ts's own call sites are the other half of this pin — a key
    // queried via issueSet must read 'issue' here, and prSet must read 'pr'.
    // Fails if fewer than the 16 the query builds parse, so a rewritten
    // query.ts the pattern no longer reads cannot pass by matching nothing.
    // Coverage is deliberately one-way: marker/autoPlan are never queried.
    // guard(#236): query.ts's own issue-vs-PR fact drifting from
    // writes.ts's, so a label queried as a pull request could still be
    // written back to as an issue.
    const callRe = /\b(issueSet|prSet)\(\s*'[^']*'\s*,\s*labels\.([A-Za-z]+)/g;
    let match;
    let callCount = 0;
    while ((match = callRe.exec(queryText))) {
      callCount += 1;
      const [, fn, key] = match;
      const expected = fn === 'issueSet' ? 'issue' : 'pr';
      if (LABEL_SURFACE[key] !== expected) {
        fail('tick-surface', `query.ts calls ${fn}(..., labels.${key}), so LABEL_SURFACE.${key} must be '${expected}', but it is '${LABEL_SURFACE[key]}'`);
      } else {
        ok();
      }
    }
    if (callCount < 16) {
      fail('tick-surface', `query.ts: only ${callCount} issueSet/prSet call sites parsed, expected at least 16 — the pattern may no longer match query.ts's shape`);
    } else {
      ok();
    }

    // Every RETRY_TRIGGER pair maps to exactly one surface: a future trigger
    // mapping that crosses surfaces (issue in-flight label resetting to a PR
    // trigger, or vice versa) is a wrong write by construction.
    // guard(#236): a liveness reset crossing surfaces, or a future write
    // hardcoding the target the way livenessResetWrite did before this fix.
    for (const [fromKey, toKey] of Object.entries<string>(RETRY_TRIGGER)) {
      if (LABEL_SURFACE[fromKey] !== LABEL_SURFACE[toKey]) {
        fail('tick-surface', `RETRY_TRIGGER.${fromKey} → ${toKey} crosses surfaces: LABEL_SURFACE.${fromKey}='${LABEL_SURFACE[fromKey]}', LABEL_SURFACE.${toKey}='${LABEL_SURFACE[toKey]}'`);
      } else {
        ok();
      }
    }

    // The #236 guard itself: no non-comment line of writes.ts may contain an
    // 'issue' or 'pr' string literal — every target must be derived through
    // LABEL_SURFACE, never typed by a caller.
    const writesText = readFileSync(join(root, TICK_DIR, 'writes.ts'), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    if (/'issue'|"issue"|'pr'|"pr"/.test(writesText)) {
      fail('tick-surface', `writes.ts contains an 'issue'/'pr' string literal outside a comment — every target must derive from LABEL_SURFACE`);
    } else {
      ok();
    }

    // Every function writes.ts exports is named by at least one case in
    // writes.cases.json, so a future write with a wrong-surface key cannot
    // ship with nothing exercising it.
    // guard(#236): a new write shipping with nothing in the decision-case
    // table exercising its target resolution.
    const exportRe = /export function (\w+)\(/g;
    const exported = [...writesText.matchAll(exportRe)].map((m) => m[1]);
    const casesTable = readJson(`${TICK_DIR}/cases/writes.cases.json`);
    const namedFns = new Set(casesTable.cases.map((c: any) => c.function));
    for (const fn of exported) {
      if (!namedFns.has(fn)) fail('tick-surface', `writes.ts exports '${fn}', which no case in writes.cases.json names`);
      else ok();
    }
  }

  // --- Ladder constants are literal, and wakeup is never null on a non-draining
  // guard(#203): a non-draining tick reaching ScheduleWakeup with nothing to
  // pass — the model reads plan/commit's 'wakeup' field directly, so a null
  // here would leave it with nothing.
  {
    const text = readFileSync(join(root, TICK_DIR, 'pacing.ts'), 'utf8');
    for (const n of ['270', '540', '1080', '1800']) {
      if (!text.includes(n)) fail('tick-pacing', `pacing.ts is missing the ladder constant '${n}'`);
      else ok();
    }
    const { nextDelay } = await importEngine(`${TICK_DIR}/pacing.ts`);
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
    const engineFiles = walk(join(root, TICK_DIR)).filter((f) => f.endsWith('.ts'));
    if (engineFiles.length === 0) fail('tick-io', `${TICK_DIR}/*.ts matched zero files — the io scan itself is broken`);
    else ok();
    const files = [join(root, 'scripts/port-tick.ts'), ...engineFiles];
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

  // --- Write composition lives only in writes.ts (#225) ----------------------
  // guard(#225): the write-composition layer drifting back into the
  // orchestrator, which is exactly where the additive-vs-swap refresh-write
  // bug lived with nothing to catch it.
  // The additive-vs-swap bug this ticket fixes lived in port-tick.ts's own
  // inline `gh ... --add-label`/`--remove-label` template literals — the one
  // layer with no case table. This keeps every future label write inside the
  // module the eighth family actually tests, instead of drifting back into
  // the orchestrator the way this one did.
  {
    const writesPath = join(root, TICK_DIR, 'writes.ts');
    const engineFiles = walk(join(root, TICK_DIR)).filter((f) => f.endsWith('.ts') && f !== writesPath);
    if (engineFiles.length === 0) fail('tick-writes', `${TICK_DIR}/*.ts (excluding writes.ts) matched zero files — the write-composition scan itself is broken`);
    else ok();
    const files = [join(root, 'scripts/port-tick.ts'), ...engineFiles];
    for (const f of files) {
      const rel = relOf(f);
      const text = readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*)/.test(l))
        .join('\n');
      if (/--add-label\b/.test(text)) fail('tick-writes', `${rel} composes '--add-label' inline — every gh label write must go through writes.ts's exported functions`);
      else ok();
      if (/--remove-label\b/.test(text)) fail('tick-writes', `${rel} composes '--remove-label' inline — every gh label write must go through writes.ts's exported functions`);
      else ok();
      if (/\bgh (issue|pr) edit\b/.test(text)) fail('tick-writes', `${rel} spells out a 'gh issue/pr edit' command literal — that composition belongs in writes.ts alone`);
      else ok();
    }
  }

  // --- SKILL.md names tickId, the verbatim rail, the TICK-PROSE.md fallback,
  // and the two defect fixes issue 187 found: `start` actually being called,
  // and `--live` always passed explicitly.
  // guard(#203, #187): the model re-deriving a decision the plan already
  // settled, or skipping `start` so the engine's session-scoped state never
  // resets. Issue 181 moved `<commands.tick> start` (Startup preflight step 7)
  // into PREFLIGHT.md, so this reads the skill union rather than SKILL.md alone.
  {
    const skillRel = 'plugins/port/skills/pipeline/*.md';
    const skillText = pipelineSkillText();
    for (const phrase of ['tickId', 'TICK-PROSE.md', 'commands.tick', '<commands.tick> start', '--live']) {
      if (!skillText.includes(phrase)) fail('tick-skill', `${skillRel} never names '${phrase}'`);
      else ok();
    }
    if (!/verbatim/i.test(skillText)) {
      fail('tick-skill', `${skillRel} never states the verbatim-execution rail`);
    } else {
      ok();
    }

    const proseRel = 'plugins/port/skills/pipeline/TICK-PROSE.md';
    const proseText = readFileSync(join(root, proseRel), 'utf8');
    if (!proseText.includes('Denials consumed')) fail('tick-skill', `${proseRel} never names 'Denials consumed' — the moved offset-read procedure`);
    else ok();
  }
}

function runCase(fn: string, impl: any, input: any): any {
  switch (fn) {
    case 'classifyEnvelope':
      return impl(input);
    case 'partitionOwnership': {
      const result = impl(input.nodes, input.viewerLogin);
      return { mine: result.mine.map((n: any) => n.number), others: result.others.map((n: any) => n.number), unowned: result.unowned.map((n: any) => n.number) };
    }
    case 'issueSessionRequiredReason':
    case 'prSessionRequiredReason':
      return impl(input);
    case 'parseFilesBlock':
      return impl(input);
    case 'gateCandidates': {
      const result = impl(input.candidates, input.occupiedSet, input.sharedFiles, input.threshold);
      return { dispatch: result.dispatch, heldItems: result.held.map((h: any) => h.item) };
    }
    case 'mergeabilityRoute':
      return impl(...input);
    case 'refreshDecision':
      return impl(...input);
    case 'capRefreshes': {
      const [candidates, max] = input;
      const result = impl(candidates, max);
      return { toRefreshNumbers: result.toRefresh.map((c: any) => c.number), deferredNumbers: result.deferred.map((c: any) => c.number) };
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
    case 'parseDenialLine':
    case 'summarizeDelta':
      return impl(input);
    case 'formatEvent':
    case 'rotationDecision':
    case 'findGaps':
    case 'deriveSpans':
    case 'renderText':
      return impl(...input);
    case 'aggregate':
      return impl(input);
    default:
      throw new Error(`no case runner wired for function '${fn}'`);
  }
}
