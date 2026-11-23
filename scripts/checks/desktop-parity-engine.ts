import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { root, readJson, relOf } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';
import { decide as hookDecide, globToRegExp as hookGlobToRegExp } from '#plugins/port/hooks/lib/guard-rules.mjs';

// Pins the desktop's copies of plugin and scripts/port-tick code to their originals.
export default async function ({ expect, fail, ok }: Reporter) {
  const mainDispatchDir = 'apps/desktop/src/main/dispatch';
  const hostingDir = 'apps/desktop/src/main/hosting';

  // --- bodies.ts has no non-`import type` import, for layer 1's own import --
  {
    const bodiesFile = 'apps/desktop/src/utils/actions/bodies.ts';
    const text = readFileSync(join(root, bodiesFile), 'utf8');
    const badImport = text.split('\n').some((line) => /^import\b/.test(line.trim()) && !/^import\s+type\b/.test(line.trim()));
    expect(!badImport, 'desktop-actions', `${bodiesFile} has a non-'import type' import — it must stay zero-runtime-dependency`);
  }

  // --- The comment bodies pass their own validators and pin their headings --
  {
    const bodiesFile = 'apps/desktop/src/utils/actions/bodies.ts';
    const scriptsPortTickGatesFile = 'scripts/port-tick/gates.ts';
    const observationFile = `${mainDispatchDir}/observation.ts`;
    const bodies = (await import(pathToFileURL(join(root, bodiesFile)).href)) as {
      CHANGES_REQUESTED_HEADING: string;
      GATE_CLEARED_HEADING: string;
      PIPELINE_ESCALATION_HEADING: string;
      changesRequestedBody: (headRefOid: string, note: string) => string;
    };
    const artifacts = (await import(pathToFileURL(join(root, 'plugins/port/bin/artifacts.mjs')).href)) as {
      CHANGES_REQUESTED_HEADING: string;
      CHECKS: Record<string, { run: (text: string) => { ok: boolean } }>;
    };

    const rendered = bodies.changesRequestedBody('a'.repeat(40), 'rename X');
    expect(artifacts.CHECKS['changes-requested'].run(rendered).ok, 'desktop-actions', `${bodiesFile}'s changesRequestedBody output fails artifacts.mjs's own 'changes-requested' validator`);

    expect(!(bodies.CHANGES_REQUESTED_HEADING !== artifacts.CHANGES_REQUESTED_HEADING), 'desktop-actions', `${bodiesFile}'s CHANGES_REQUESTED_HEADING ('${bodies.CHANGES_REQUESTED_HEADING}') disagrees with artifacts.mjs's ('${artifacts.CHANGES_REQUESTED_HEADING}')`);

    const portTickGatesText = readFileSync(join(root, scriptsPortTickGatesFile), 'utf8');
    const portTickGatesMatch = /GATE_CLEARED_PREFIX\s*=\s*'([^']+)'/.exec(portTickGatesText);
    if (!portTickGatesMatch) {
      fail('desktop-actions', `${scriptsPortTickGatesFile} has no 'GATE_CLEARED_PREFIX = ...' literal to compare`);
    } else expect(!(bodies.GATE_CLEARED_HEADING !== portTickGatesMatch[1]), 'desktop-actions', `${bodiesFile}'s GATE_CLEARED_HEADING ('${bodies.GATE_CLEARED_HEADING}') disagrees with ${scriptsPortTickGatesFile}'s ('${portTickGatesMatch[1]}')`);

    const observationText = readFileSync(join(root, observationFile), 'utf8');
    const observationMatch = /PIPELINE_ESCALATION\s*=\s*'([^']+)'/.exec(observationText);
    if (!observationMatch) {
      fail('desktop-actions', `${observationFile} has no 'PIPELINE_ESCALATION = ...' literal to compare`);
    } else expect(!(bodies.PIPELINE_ESCALATION_HEADING !== observationMatch[1]), 'desktop-actions', `${bodiesFile}'s PIPELINE_ESCALATION_HEADING ('${bodies.PIPELINE_ESCALATION_HEADING}') disagrees with ${observationFile}'s ('${observationMatch[1]}')`);
  }

  // pin: `main/github/query.ts`'s `CheckRollupFields` fragment selection ↔ `scripts/port-tick/query.ts`'s own `ROLLUP`, both directions
  {
    const queryFile = 'apps/desktop/src/main/github/query.ts';
    const queryText = readFileSync(join(root, queryFile), 'utf8');
    const fragmentMatch = /CHECK_ROLLUP_FRAGMENT\s*=\s*`fragment CheckRollupFields on PullRequest \{([\s\S]*?)\n\}`/.exec(queryText);
    const engineText = readFileSync(join(root, 'scripts/port-tick/query.ts'), 'utf8');
    const rollupMatch = /const ROLLUP\s*=\s*`([^`]*)`/.exec(engineText);

    if (!fragmentMatch) {
      fail('desktop-github-adapter', `${queryFile} has no 'CHECK_ROLLUP_FRAGMENT = \`fragment CheckRollupFields on PullRequest {...}\`' to compare`);
    } else if (!rollupMatch) {
      fail('desktop-github-adapter', `scripts/port-tick/query.ts has no 'const ROLLUP = \`...\`' to compare`);
    } else {
      // Both sides read as the set of GraphQL field/selection tokens, never byte-identical text.
      const tokenize = (text: string): Set<string> => new Set(text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
      const appTokens = tokenize(fragmentMatch[1]);
      const engineTokens = tokenize(rollupMatch[1]);
      const onlyInApp = [...appTokens].filter((t) => !engineTokens.has(t));
      const onlyInEngine = [...engineTokens].filter((t) => !appTokens.has(t));
      expect(!(onlyInApp.length > 0 || onlyInEngine.length > 0), 'desktop-github-adapter', `${queryFile}'s CheckRollupFields selection and scripts/port-tick/query.ts's ROLLUP disagree — only in the app: ${onlyInApp.join(', ') || '(none)'}; only in the engine: ${onlyInEngine.join(', ') || '(none)'}`);
    }
  }

  // pin: `main/dispatch/budget.ts`'s `BUDGET_VERDICTS` ↔ `bin/budget.mjs`'s `verdict()`, both directions
  {
    const budgetFile = `${mainDispatchDir}/budget.ts`;
    const budgetLedgerFile = `${mainDispatchDir}/budget-ledger.ts`;
    const budgetScriptPath = join(root, 'plugins/port/bin/budget.mjs');
    const budgetText = readFileSync(join(root, budgetFile), 'utf8');
    const verdictsMatch = /BUDGET_VERDICTS\s*=\s*\[([^\]]*)\]/.exec(budgetText);
    const mod = await import(pathToFileURL(budgetScriptPath).href);
    const scriptVerdicts = new Set([
      mod.verdict({ secondsUsed: 0, ceilingSeconds: null }),
      mod.verdict({ secondsUsed: 100, ceilingSeconds: 100 }),
      'hold', // verdict() never returns 'hold' itself — a caller-level state for an unreadable ledger (its own doc comment)
    ]);
    if (!verdictsMatch) {
      fail('desktop-dispatch', `${budgetFile} has no 'BUDGET_VERDICTS = [...]' array to compare against`);
    } else {
      const appVerdicts = new Set([...verdictsMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
      const onlyInApp = [...appVerdicts].filter((v) => !scriptVerdicts.has(v));
      const onlyInScript = [...scriptVerdicts].filter((v) => !appVerdicts.has(v));
      expect(!(onlyInApp.length > 0 || onlyInScript.length > 0), 'desktop-dispatch', `${budgetFile}'s BUDGET_VERDICTS (${[...appVerdicts].join(', ')}) and bin/budget.mjs's verdicts (${[...scriptVerdicts].join(', ')}) disagree`);
    }

    // pin: `BUDGET_SESSION` is a session name the desktop's own `sessionLogName` accepts
    const sessionMatch = /BUDGET_SESSION\s*=\s*'([^']+)'/.exec(budgetText);
    const ledgerMod = await import(pathToFileURL(join(root, budgetLedgerFile)).href);
    if (!sessionMatch) {
      fail('desktop-dispatch', `${budgetFile} has no 'BUDGET_SESSION = ...' assignment`);
    } else expect(!(ledgerMod.sessionLogName(sessionMatch[1]) === null), 'desktop-dispatch', `${budgetFile}'s BUDGET_SESSION ('${sessionMatch[1]}') is rejected by ${budgetLedgerFile}'s own sessionLogName — the gate would fail on every call`);

    // pin: renderer parity — the desktop's ledger module and bin/budget.mjs, over fixed fixtures, must agree byte for byte
    const ceilings = [null, 7200];
    const row = (seconds: number) => ({ stage: 'impl', model: 'sonnet', startedAt: '2026-09-05T14:00:00.000Z', seconds, outcome: 'completed' });
    const rowSets = [[], [row(120)], [row(120), row(5), row(3600)]];
    const sessionRows = [
      { issue: 52, dispatchNumber: 213, stage: 'review', model: 'opus', startedAt: '2026-09-05T14:00:00.000Z', state: 'closed', seconds: 30, outcome: 'completed' },
      { issue: 7, dispatchNumber: 7, stage: 'plan', model: 'opus', startedAt: '2026-09-05T15:00:00.000Z', state: 'open', seconds: 0, outcome: 'lost' },
    ];
    const cases: { name: string; input: unknown; app: unknown; script: unknown }[] = [];
    for (const rows of rowSets) {
      for (const ceiling of ceilings) {
        const input = { rows: rows.length, ceiling };
        const app = ledgerMod.renderLedger(rows, ceiling);
        const script = mod.renderLedger(rows, ceiling);
        cases.push({ name: 'renderLedger', input, app, script });
        cases.push({ name: 'parseLedger (app output read by the script)', input, app: ledgerMod.parseLedger(script), script: mod.parseLedger(app) });
      }
    }
    for (const seconds of [0, 59, 3599, 3600, 7322]) cases.push({ name: 'formatDuration', input: seconds, app: ledgerMod.formatDuration(seconds), script: mod.formatDuration(seconds) });
    for (const tickets of [[], [{ issue: 52, secondsUsed: 60, ceilingSeconds: 120 }, { issue: 7, secondsUsed: 60, ceilingSeconds: null }]]) {
      const totals = { dispatches: 2, seconds: 125 };
      cases.push({ name: 'renderTickClause', input: tickets.length, app: ledgerMod.renderTickClause(totals, tickets), script: mod.renderTickClause(totals, tickets) });
    }
    cases.push({ name: 'renderSessionLog', input: 'two rows', app: ledgerMod.renderSessionLog(sessionRows), script: mod.renderSessionLog(sessionRows) });
    cases.push({ name: 'parseSessionLog (app output read by the script)', input: 'two rows', app: ledgerMod.parseSessionLog(mod.renderSessionLog(sessionRows)), script: mod.parseSessionLog(ledgerMod.renderSessionLog(sessionRows)) });
    for (const session of [undefined, 'desktop', 'Bad Name']) cases.push({ name: 'sessionLogName', input: session, app: ledgerMod.sessionLogName(session), script: mod.sessionLogName(session) });
    for (const cfg of [{}, { budget: { wallClockMinutes: 120 } }, { budget: { wallClockMinutes: '120' } }, { budget: { wallClockMinutes: 0 } }]) {
      cases.push({ name: 'ceilingSecondsFrom', input: cfg, app: ledgerMod.ceilingSecondsFrom(cfg), script: mod.ceilingSecondsFrom(cfg) });
    }
    const differing = cases.find((c) => JSON.stringify(c.app) !== JSON.stringify(c.script));
    expect(differing === undefined, 'desktop-dispatch', `${budgetLedgerFile} and bin/budget.mjs disagree on ${differing?.name} for ${JSON.stringify(differing?.input)}: ${JSON.stringify(differing?.app)} vs ${JSON.stringify(differing?.script)}`);

    // pin: the ledger module has no value import, since the parity load above runs it under Node with no alias resolver
    const ledgerText = readFileSync(join(root, budgetLedgerFile), 'utf8');
    expect(!/^import\s+(?!type\b)/m.test(ledgerText), 'desktop-dispatch', `${budgetLedgerFile} has a non-type import — the parity check loads it directly under Node, where an @/ alias does not resolve`);
  }

  // pin: the escalation marker prefix and every cause the app emits ↔ `gates.ts`'s `escalationMarker` and `ESCALATION_CAUSES`
  {
    const observationFile = `${mainDispatchDir}/observation.ts`;
    const observationText = readFileSync(join(root, observationFile), 'utf8');
    const budgetText = readFileSync(join(root, `${mainDispatchDir}/budget.ts`), 'utf8');
    const gatesText = readFileSync(join(root, 'scripts/port-tick/gates.ts'), 'utf8');
    const markerPrefix = '<!-- port:escalation ';
    let markerDrift = false;
    for (const [name, text] of [['gates.ts', gatesText], [observationFile, observationText], [`${mainDispatchDir}/budget.ts`, budgetText]] as const) {
      if (!text.includes(markerPrefix)) {
        markerDrift = true;
        fail('desktop-dispatch', `${name} no longer writes the '${markerPrefix}' escalation marker prefix`);
      }
    }
    const appCauses: readonly (readonly [string, string])[] = [['sha-cap', observationText], ['cycle-cap', observationText], ['integration-red', observationText], ['refresh-stuck', observationText], ['budget', budgetText]];
    for (const [cause, text] of appCauses) {
      if (!gatesText.includes(`'${cause}'`) || !text.includes(cause)) {
        markerDrift = true;
        fail('desktop-dispatch', `the '${cause}' escalation cause is missing from gates.ts's ESCALATION_CAUSES or from the app file that emits it`);
      }
    }
    if (!markerDrift) ok();
  }

  // --- stage-policy.ts's own globToRegExp agrees with guard-rules.mjs's over a shared case list, both directions. ---
  {
    const module = (await import(pathToFileURL(join(root, `${hostingDir}/stage-policy.ts`)).href)) as { readonly globToRegExp?: (glob: string) => RegExp };
    if (typeof module.globToRegExp !== 'function') {
      fail('desktop-hosting', `${hostingDir}/stage-policy.ts does not export 'globToRegExp'`);
    } else {
      const appGlobToRegExp = module.globToRegExp;
      const cases: readonly { readonly glob: string; readonly path: string; readonly matches: boolean }[] = [
        { glob: 'CLAUDE.md', path: 'CLAUDE.md', matches: true },
        { glob: 'CLAUDE.md', path: 'src/CLAUDE.md', matches: false },
        { glob: '.claude/**', path: '.claude/settings.json', matches: true },
        { glob: '.claude/**', path: '.claude/sub/dir/file.json', matches: true },
        { glob: '.claude/**', path: '.claudexyz', matches: false },
        { glob: 'src/*.ts', path: 'src/index.ts', matches: true },
        { glob: 'src/*.ts', path: 'src/sub/index.ts', matches: false },
        { glob: 'infra/**', path: 'infra', matches: false },
      ];
      let allAgree = true;
      for (const { glob, path, matches } of cases) {
        const hook = hookGlobToRegExp(glob).test(path);
        const app = appGlobToRegExp(glob).test(path);
        if (hook !== matches || app !== matches) {
          allAgree = false;
          fail('desktop-hosting', `globToRegExp parity: glob ${glob} against ${path} — guard-rules.mjs says ${String(hook)}, stage-policy.ts says ${String(app)}, expected ${String(matches)}`);
        }
      }
      if (allAgree) ok();
    }
  }

  // --- guard-marker.ts's marker is in the guard's allowlist-miss reason and in none of its other denial reasons. ---
  {
    const module = (await import(pathToFileURL(join(root, `${hostingDir}/guard-marker.ts`)).href)) as { readonly GUARD_ALLOWLIST_MISS_MARKER?: string };
    const marker = module.GUARD_ALLOWLIST_MISS_MARKER;
    if (typeof marker !== 'string') {
      fail('desktop-hosting', `${hostingDir}/guard-marker.ts does not export 'GUARD_ALLOWLIST_MISS_MARKER'`);
    } else {
      const subagent = { agent_type: 'port:impl-agent', cwd: `${root}/.claude/worktrees/impl-1` };
      const base = { matchers: [], sessionRequiredPaths: ['.claude/**'], root, needsHumanLabel: null, operatorMessages: null, isCockpitSession: false, ownership: null, cockpitFilePath: null, repo: null, approvedLabel: null };
      const reasonOf = (tool_name: string, tool_input: Record<string, unknown>): string => {
        const decision = hookDecide({ ...base, payload: { ...subagent, tool_name, tool_input } }) as { readonly reason?: string };
        return decision.reason ?? '';
      };
      const miss = reasonOf('Bash', { command: 'cp a b' });
      const loop = reasonOf('Bash', { command: 'for n in 1 2; do gh issue view $n; done' });
      const protectedWrite = reasonOf('Write', { file_path: join(root, '.claude/settings.json') });
      expect(miss.includes(marker), 'desktop-hosting', `guard-rules.mjs's allowlist-miss reason no longer contains hook-denials.ts's marker "${marker}"`);
      expect(!loop.includes(marker) && loop.length > 0, 'desktop-hosting', "guard-rules.mjs's shell-loop reason must be non-empty and must not contain the allowlist-miss marker");
      expect(!protectedWrite.includes(marker) && protectedWrite.length > 0, 'desktop-hosting', "guard-rules.mjs's sessionRequiredPaths reason must be non-empty and must not contain the allowlist-miss marker");
    }
  }

  // pin: `bin/worktrees.mjs`'s `correlate` ↔ the desktop `correlate` (`apps/desktop/src/main/local/correlate.ts`)
  {
    const testsDir = 'apps/desktop/tests/unit/main/local';
    const casesPath = join(root, testsDir, 'correlation.cases.json');
    const cases = readJson(`${testsDir}/correlation.cases.json`);

    const rungs = new Set<string>(cases.map((c: any) => c.expect?.rung).filter(Boolean));
    for (const rung of ['upstream-branch', 'branch-name', 'directory-basename', 'head-subject']) {
      if (!rungs.has(rung)) {
        fail('desktop-local-correlation-table', `${relOf(casesPath)} has no case whose expect.rung is '${rung}' — the table must cover all four rungs`);
      }
    }
    if (!cases.some((c: any) => c.name.includes('#0'))) {
      fail('desktop-local-correlation-table', `${relOf(casesPath)} has no '#0' case`);
    }
    if (!cases.some((c: any) => c.expect === null)) {
      fail('desktop-local-correlation-table', `${relOf(casesPath)} has no case expecting null (a fully unresolvable entry)`);
    }
    ok();

    const { correlate } = await import(pathToFileURL(join(root, 'plugins/port/bin/worktrees.mjs')).href);
    for (const c of cases) {
      const actual = correlate(c.input);
      const expected = c.expect;
      const matches = expected === null ? actual === null : actual !== null && actual.number === expected.number && actual.rung === expected.rung;
      if (!matches) {
        fail(
          'desktop-local-correlation-table',
          `bin/worktrees.mjs's correlate() disagrees with '${c.name}': expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        );
      }
    }
    ok();
  }

  // --- The reclaimer's state vocabulary and four pure decisions agree with bin/worktrees.mjs. ---
  {
    const templatePath = join(root, 'plugins/port/bin/worktrees.mjs');
    const templateText = readFileSync(templatePath, 'utf8');
    const typesPath = join(root, 'apps/desktop/src/types/reclaimer.ts');
    const typesText = readFileSync(typesPath, 'utf8');
    const statesMatch = /WORKTREE_STATES\s*=\s*\[([^\]]*)\]\s*as const/.exec(typesText);
    const reclaimableMatch = /RECLAIMABLE_STATES\s*=\s*\[([^\]]*)\]\s*as const/.exec(typesText);
    const script = await import(pathToFileURL(templatePath).href);

    // pin: `bin/worktrees.mjs`'s state vocabulary (`describeReason`'s cases, and which states `classifyCandidate` returns `removable: true` for) ↔ `types/reclaimer.ts`'s `WORKTREE_STATES`/`RECLAIMABLE_STATES`
    {
      if (!statesMatch || !reclaimableMatch) {
        fail('desktop-reclaimer', `${relOf(typesPath)} has no 'WORKTREE_STATES = [...] as const' or 'RECLAIMABLE_STATES = [...] as const' array`);
      } else {
        const appStates = [...statesMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
        const appReclaimable = [...reclaimableMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

        const reasonFnMatch = /function describeReason\(c\) \{([\s\S]*?)\n\}/.exec(templateText);
        if (!reasonFnMatch) {
          fail('desktop-reclaimer', `${relOf(templatePath)} has no 'function describeReason(c) {...}' to read case labels from`);
        } else {
          const templateStates = [...reasonFnMatch[1].matchAll(/case '([^']+)'/g)].map((m) => m[1]);
          const templateSet = new Set(templateStates);
          const appSet = new Set(appStates);
          for (const state of appStates) {
            if (!templateSet.has(state)) {
              fail('desktop-reclaimer', `WORKTREE_STATES has '${state}', which bin/worktrees.mjs's describeReason has no case for`);
            }
          }
          for (const state of templateStates) {
            if (!appSet.has(state)) {
              fail('desktop-reclaimer', `bin/worktrees.mjs's describeReason has a case for '${state}', missing from WORKTREE_STATES`);
            }
          }
        }

        const removableStates = new Set<string>();
        for (const itemState of ['OPEN', 'CLOSED', 'MERGED', null]) {
          for (const isAncestor of [true, false, null]) {
            const result = script.classifyCandidate({ isOutside: false, isProtected: false, locked: false, dirty: false, itemState, isAncestor });
            if (result.removable) removableStates.add(result.state);
          }
        }
        const reclaimableSet = new Set<string>(appReclaimable);
        for (const state of removableStates) {
          if (!reclaimableSet.has(state)) {
            fail('desktop-reclaimer', `classifyCandidate can return removable:true for '${state}', missing from RECLAIMABLE_STATES`);
          }
        }
        for (const state of appReclaimable) {
          if (!removableStates.has(state)) {
            fail('desktop-reclaimer', `RECLAIMABLE_STATES lists '${state}', but classifyCandidate never returns removable:true for it`);
          }
        }
      }
      ok();
    }

    // pin: `bin/worktrees.mjs`'s four pure decisions ↔ `main/reclaimer/classify.ts`, through the case table both run
    {
      const casesRel = 'apps/desktop/tests/unit/main/reclaimer/classify.cases.json';
      const cases = readJson(casesRel);
      // The script omits `otherwiseRemovable` for an outside or protected candidate; the port always carries it.
      const runners: Record<string, (input: any) => unknown> = {
        classifyCandidate: (input) => ({ otherwiseRemovable: false, ...script.classifyCandidate(input) }),
        fallbackDecision: (input) => script.fallbackDecision(input),
        orphanVerdict: (input) => script.orphanVerdict(input),
        classifyRemovalFailure: (input) => script.classifyRemovalFailure(input),
      };

      for (const [fn, run] of Object.entries(runners)) {
        const rows: any[] = Array.isArray(cases[fn]) ? cases[fn] : [];
        if (rows.length === 0) {
          fail('desktop-reclaimer', `${casesRel} has no '${fn}' cases — the table must cover every function the port shares with the script`);
          continue;
        }
        for (const row of rows) {
          const actual = run(row.input);
          if (!isDeepStrictEqual(actual, row.expect)) {
            fail('desktop-reclaimer', `bin/worktrees.mjs's ${fn}() disagrees with '${row.name}': expected ${JSON.stringify(row.expect)}, got ${JSON.stringify(actual)}`);
          }
        }
      }

      const expected = (fn: string): Set<string> => new Set((cases[fn] ?? []).map((r: any) => (typeof r.expect === 'object' && r.expect !== null ? (r.expect.state ?? r.expect.action) : r.expect)));
      const appStates = statesMatch ? [...statesMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
      const coverage: [string, Set<string>, string[]][] = [
        ['classifyCandidate', expected('classifyCandidate'), appStates],
        ['fallbackDecision', expected('fallbackDecision'), ['done', 'fallback', 'abort']],
        ['classifyRemovalFailure', expected('classifyRemovalFailure'), ['file-in-use', 'long-path', 'unknown']],
      ];
      for (const [fn, seen, required] of coverage) {
        for (const value of required) {
          if (!seen.has(value)) fail('desktop-reclaimer', `${casesRel} has no '${fn}' case expecting '${value}' — the table must cover every outcome`);
        }
      }
      ok();
    }
  }

  // pin: `apps/desktop/src/main/registry/effective.ts`'s `parseExcusedCheckName` anchor (`'\njobs:'`, `/\n {2}([A-Za-z0-9_-]+):/`) ↔ `scripts/port-tick/config.ts`'s `resolveExcusedCheckName`, both directions
  {
    const effectiveText = readFileSync(join(root, 'apps/desktop/src/main/registry/effective.ts'), 'utf8');
    const configText = readFileSync(join(root, 'scripts/port-tick/config.ts'), 'utf8');
    for (const [label, text] of [
      ['apps/desktop/src/main/registry/effective.ts', effectiveText],
      ['scripts/port-tick/config.ts', configText],
    ] as const) {
      if (!text.includes("'\\njobs:'")) {
        fail('desktop-registry', `${label} does not carry the '\\njobs:' anchor`);
      } else expect(text.includes('/\\n {2}([A-Za-z0-9_-]+):/'), 'desktop-registry', `${label} does not carry the /\\n {2}([A-Za-z0-9_-]+):/ regex literal`);
    }
  }

  // pin: `main/tick/routing.ts`'s `AGENT_FOR_IN_FLIGHT` ↔ `scripts/port-tick/liveness.ts`'s own `buildLivenessExpected` (labelKey, stage) pairs, both directions
  {
    const routingFile = 'apps/desktop/src/main/tick/routing.ts';
    const routingText = readFileSync(join(root, routingFile), 'utf8');
    const inFlightMatch = /const AGENT_FOR_IN_FLIGHT[^{]*\{([^}]*)\}/.exec(routingText);
    const engineText = readFileSync(join(root, 'scripts/port-tick/liveness.ts'), 'utf8');
    const specsMatch = /const specs[^=]*=\s*\[([\s\S]*?)\]\s*;/.exec(engineText);

    if (!inFlightMatch) {
      fail('desktop-tick', `${routingFile} has no 'AGENT_FOR_IN_FLIGHT = {...}' object to compare`);
    } else if (!specsMatch) {
      fail('desktop-tick', `scripts/port-tick/liveness.ts has no 'specs = [...]' array to compare buildLivenessExpected against`);
    } else {
      const appPairs = new Map([...inFlightMatch[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));
      const enginePairs = new Map(
        [...specsMatch[1].matchAll(/\[\s*'(\w+)'\s*,\s*'(\w+)'\s*,\s*'([\w-]+)'\s*\]/g)].map((m) => [m[2], m[3].replace(/-agent$/, '')]),
      );
      const allKeys = new Set([...appPairs.keys(), ...enginePairs.keys()]);
      const mismatches = [...allKeys].filter((key) => appPairs.get(key) !== enginePairs.get(key));
      expect(!(mismatches.length > 0), 'desktop-tick', `${routingFile}'s AGENT_FOR_IN_FLIGHT and scripts/port-tick/liveness.ts's buildLivenessExpected disagree on: ${mismatches.join(', ')}`);
    }
  }

  // pin: `main/dispatch/observation.ts`'s `observationWrite` label plan ↔ `scripts/port-tick/writes.ts`'s own write functions, both directions
  {
    const observationPath = join(root, `${mainDispatchDir}/observation.ts`);
    const writesPath = join(root, 'scripts/port-tick/writes.ts');
    const observationModule = await import(pathToFileURL(observationPath).href);
    const writesModule = await import(pathToFileURL(writesPath).href);

    const identityLabels: Record<string, string> = new Proxy({}, { get: (_t, key: string) => key }) as Record<string, string>;
    const identityVocabulary = { labels: [] as any[] };
    const baseItem = { stages: [] as any[], assignees: [] as string[] };
    const flagsOf = (command: string) => ({
      add: /--add-label "([^"]+)"/.exec(command)?.[1] ?? null,
      remove: /--remove-label "([^"]+)"/.exec(command)?.[1] ?? null,
    });

    const cases: Array<{ readonly name: string; readonly app: () => { readonly add: readonly string[]; readonly remove: readonly string[] }; readonly engine: () => { readonly command: string } }> = [
      {
        name: 'liveness-reset',
        app: () => observationModule.observationWrite({ kind: 'liveness-reset', number: 1, itemKind: 'issue', inFlight: 'planning', retryKey: 'ready' }, baseItem, identityVocabulary, 'dev'),
        engine: () => writesModule.livenessResetWrite({ repo: 'o/r', labels: identityLabels, item: 1, fromKey: 'planning', toKey: 'ready' }),
      },
      {
        name: 'cycle-cap',
        app: () => observationModule.observationWrite({ kind: 'cycle-cap', number: 1, itemKind: 'pull-request', count: 5, cap: 5 }, baseItem, identityVocabulary, 'dev'),
        engine: () => writesModule.cycleCapWrite({ repo: 'o/r', labels: identityLabels, number: 1 }),
      },
      {
        name: 'zero-diff',
        app: () => observationModule.observationWrite({ kind: 'zero-diff', number: 1, itemKind: 'pull-request', count: 1, headRefOid: 'abc' }, baseItem, identityVocabulary, 'dev'),
        engine: () => writesModule.zeroDiffWrite({ repo: 'o/r', labels: identityLabels, number: 1 }),
      },
      {
        name: 'integration-red',
        app: () => observationModule.observationWrite({ kind: 'integration-red', number: 1, itemKind: 'pull-request', checks: ['test'], headRefOid: 'abc' }, baseItem, identityVocabulary, 'dev'),
        engine: () => writesModule.integrationRedEscalationWrite({ repo: 'o/r', labels: identityLabels, number: 1 }),
      },
      {
        name: 'refresh',
        app: () => observationModule.observationWrite({ kind: 'refresh', number: 1, itemKind: 'pull-request', sourceLabel: 'readyForReview', headRefOid: 'abc', count: 1, cause: 'conflict' }, baseItem, identityVocabulary, 'dev'),
        engine: () => writesModule.refreshSweepWrite({ repo: 'o/r', labels: identityLabels, candidate: { number: 1, sourceLabelKey: 'readyForReview' }, decision: { action: 'refresh' } }),
      },
      {
        name: 'refresh (integration-green)',
        app: () => observationModule.observationWrite({ kind: 'refresh', number: 1, itemKind: 'pull-request', sourceLabel: 'readyForReview', headRefOid: 'abc', count: 1, cause: 'integration-green' }, baseItem, identityVocabulary, 'dev'),
        engine: () => writesModule.refreshSweepWrite({ repo: 'o/r', labels: identityLabels, candidate: { number: 1, sourceLabelKey: 'readyForReview', reason: 'integration-green' }, decision: { action: 'refresh' } }),
      },
      {
        name: 'refresh-stuck',
        app: () =>
          observationModule.observationWrite({ kind: 'refresh-stuck', number: 1, itemKind: 'pull-request', sourceLabel: 'readyForReview', reason: 'same-sha', sha: 'abc', count: 1 }, baseItem, identityVocabulary, 'dev'),
        engine: () => writesModule.refreshSweepWrite({ repo: 'o/r', labels: identityLabels, candidate: { number: 1, sourceLabelKey: 'readyForReview' }, decision: { action: 'escalate', reason: 'same-sha' } }),
      },
      {
        name: 'withdraw-approval',
        app: () => observationModule.observationWrite({ kind: 'withdraw-approval', number: 1, itemKind: 'pull-request', red: [], headRefOid: 'abc' }, baseItem, identityVocabulary, 'dev'),
        engine: () => writesModule.approvalWithdrawnWrite({ repo: 'o/r', labels: identityLabels, number: 1 }),
      },
    ];

    let violated = false;
    for (const { name, app, engine } of cases) {
      const appPlan = app();
      const engineFlags = flagsOf(engine().command);
      const appAdd = appPlan.add[0] ?? null;
      const appRemove = appPlan.remove[0] ?? null;
      if (appAdd !== engineFlags.add || appRemove !== engineFlags.remove) {
        violated = true;
        fail(
          'desktop-tick',
          `observation.ts's '${name}' write (add ${String(appAdd)}, remove ${String(appRemove)}) disagrees with writes.ts's own (add ${String(engineFlags.add)}, remove ${String(engineFlags.remove)})`,
        );
      }
    }
    if (!violated) ok();
  }

  // pin: observation.ts's inlined CYCLE_CAP_ESCALATION_MARKER ↔ bodies.ts's exported constant
  {
    const observationSource = readFileSync(join(root, `${mainDispatchDir}/observation.ts`), 'utf8');
    const bodiesPath = join(root, 'apps/desktop/src/utils/actions/bodies.ts');
    const bodiesModule = await import(pathToFileURL(bodiesPath).href);
    const literalMatch = /CYCLE_CAP_ESCALATION_MARKER = '([^']+)'/.exec(observationSource);
    if (literalMatch?.[1] !== bodiesModule.CYCLE_CAP_ESCALATION_MARKER) {
      fail('desktop-tick', `observation.ts's inlined cycle-cap marker (${String(literalMatch?.[1])}) disagrees with bodies.ts's own export (${String(bodiesModule.CYCLE_CAP_ESCALATION_MARKER)})`);
    } else ok();
  }
}
