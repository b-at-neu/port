import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipelineDocsText, pipelineSkillText, root, walk, relOf } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';

// Operator control over dispatch and the app's own dispatch loop, plus the budget gate's own
// rails — mechanical, dependency-free, regex-based rails.
export default async function ({ expect, fail, ok }: Reporter) {
  const dispatchTypesFile = 'apps/desktop/src/types/dispatch.ts';
  const mainDispatchDir = 'apps/desktop/src/main/dispatch';
  const resolveFile = `${mainDispatchDir}/resolve.ts`;
  const haltFile = `${mainDispatchDir}/halt.ts`;
  const dispatcherFile = `${mainDispatchDir}/dispatcher.ts`;
  const budgetFile = `${mainDispatchDir}/budget.ts`;
  const budgetGateFile = `${mainDispatchDir}/budget-gate.ts`;
  const budgetLedgerFile = `${mainDispatchDir}/budget-ledger.ts`;
  const budgetScriptPath = join(root, 'plugins/port/bin/budget.mjs');
  const dispatchableFile = 'apps/desktop/src/main/tick/dispatchable.ts';
  const trajectoryFile = 'apps/desktop/src/main/trajectory/log.ts';

  const srcDir = join(root, 'apps/desktop/src');
  const allFiles = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  const dispatchTypesFiles = allFiles.filter((f) => relOf(f) === dispatchTypesFile);
  const mainDispatchFiles = allFiles.filter((f) => relOf(f).startsWith(`${mainDispatchDir}/`));

  // --- main/dispatch/ has source files, so nothing below passes vacuously once deleted. ---
  expect(!(mainDispatchFiles.filter((f) => !relOf(f).endsWith('.test.ts')).length === 0), 'desktop-dispatch', `${mainDispatchDir} has no source files — the guard cannot pass vacuously if the directory is deleted`);

  // --- types/dispatch.ts compiles under typecheck:web, the same rail utils/actions/ holds. ---
  {
    let found = false;
    for (const f of dispatchTypesFiles) {
      const text = readFileSync(f, 'utf8');
      if (/from\s+'node:/.test(text) || /from\s+'.*\/main\//.test(text)) {
        found = true;
        fail('desktop-dispatch', `${relOf(f)} imports a node: builtin or a main/ path — types/dispatch.ts must compile under typecheck:web`);
      }
    }
    if (!found) ok();
  }

  // --- running/alive/isLive banned under types/dispatch.ts and main/dispatch/ — never report
  // a recency or attachment fact as liveness. ---
  {
    let found = false;
    for (const f of [...dispatchTypesFiles, ...mainDispatchFiles]) {
      const rel = relOf(f);
      if (rel.endsWith('.test.ts')) continue;
      const text = readFileSync(f, 'utf8');
      if (/\b(running|alive|isLive)\b/.test(text)) {
        found = true;
        fail('desktop-dispatch', `${rel} uses a running/alive/isLive-shaped name — report activity or attachment, never liveness`);
      }
    }
    if (!found) ok();
  }

  // --- The gate rail: .actionable is read under main/ only where documented. main/
  // trajectory/log.ts is a pre-existing, reporting-only reader, allowed alongside dispatchable.ts itself. ---
  {
    const allowed = new Set([dispatchableFile, trajectoryFile]);
    let sawDispatchable = false;
    let found = false;
    for (const f of allFiles) {
      const rel = relOf(f);
      if (!rel.startsWith('apps/desktop/src/main/') || rel.endsWith('.test.ts')) continue;
      const text = readFileSync(f, 'utf8');
      if (!/\.actionable\b/.test(text)) continue;
      if (allowed.has(rel)) {
        if (rel === dispatchableFile) sawDispatchable = true;
      } else {
        found = true;
        fail('desktop-dispatch', `${rel} reads '.actionable' directly — only ${dispatchableFile} (the gate) and ${trajectoryFile} (reporting) may`);
      }
    }
    if (!sawDispatchable) fail('desktop-dispatch', `${dispatchableFile} never reads '.actionable' — the gate itself must`);
    else if (!found) ok();
  }

  // --- The literal 'dispatching' appears exactly once under main/dispatch/ — never a
  // second place constructing the one open run-state value by retyping the literal. ---
  {
    let count = 0;
    for (const f of mainDispatchFiles) {
      if (relOf(f).endsWith('.test.ts')) continue;
      const text = readFileSync(f, 'utf8');
      count += (text.match(/'dispatching'/g) ?? []).length;
    }
    expect(!(count !== 1), 'desktop-dispatch', `the literal 'dispatching' appears ${count} times under ${mainDispatchDir} — expected exactly 1 (the v1 migration in store.ts)`);
  }

  // --- resolve.ts validates against DISPATCH_COMMANDS by name, never a retyped command list. ---
  {
    const text = readFileSync(join(root, resolveFile), 'utf8');
    if (!/DISPATCH_COMMANDS/.test(text)) {
      fail('desktop-dispatch', `${resolveFile} never references DISPATCH_COMMANDS — command validation must resolve it by name, never a retyped list`);
    } else expect(!/\[\s*'run'\s*,\s*'drain'\s*,\s*'pause'\s*,\s*'take-over'\s*\]/.test(text), 'desktop-dispatch', `${resolveFile} retypes the command list as a literal array instead of validating against DISPATCH_COMMANDS`);
  }

  // --- In halt.ts, runStates.set( precedes stopFor(, which precedes applyItemAction(,
  // which precedes standDown( — resetting labels before each prior step is confirmed would misfire. ---
  {
    const text = readFileSync(join(root, haltFile), 'utf8');
    const setIdx = text.indexOf('runStates.set(');
    // Optional chaining counts the same as a bare call.
    const stopForMatch = /stopFor\??\.?\(/.exec(text);
    const stopForIdx = stopForMatch ? stopForMatch.index : -1;
    const applyIdx = text.indexOf('applyItemAction(');
    const standDownMatch = /standDown\??\.?\(/.exec(text);
    const standDownIdx = standDownMatch ? standDownMatch.index : -1;
    if (setIdx === -1) {
      fail('desktop-dispatch', `${haltFile} never calls runStates.set( — halt must pause before it stops anything`);
    } else if (stopForIdx === -1) {
      fail('desktop-dispatch', `${haltFile} never calls stopFor( — the dispatcher's own per-item stop must run before each label reset`);
    } else if (applyIdx === -1) {
      fail('desktop-dispatch', `${haltFile} never calls applyItemAction( — the guard cannot compare an ordering that isn't there`);
    } else if (standDownIdx === -1) {
      fail('desktop-dispatch', `${haltFile} never calls standDown( — the dispatcher's own whole-session stand-down must run after the item loop`);
    } else expect((setIdx < stopForIdx && stopForIdx < applyIdx && applyIdx < standDownIdx), 'desktop-dispatch', `${haltFile}'s own runStates.set(/stopFor(/applyItemAction(/standDown( calls are out of order — expected runStates.set( before stopFor( before applyItemAction( before standDown(`);
  }

  // --- dispatcher.ts calls deps.readOwnership( and dispatches only for owner 'app' — must never check against the wrong verdict. ---
  {
    const text = readFileSync(join(root, dispatcherFile), 'utf8');
    if (!/\bdeps\.readOwnership\s*\(/.test(text)) {
      fail('desktop-dispatch', `${dispatcherFile} never calls deps.readOwnership( — the owner resolution this whole module rests on is missing`);
    } else expect(text.includes("owner === 'app'"), 'desktop-dispatch', `${dispatcherFile} never checks owner === 'app' — it cannot be reading the ownership record for the right thing`);
  }

  // --- budget-unported is gone; the gate runs instead, in order: re-read, then gate, then send. ---
  {
    let foundRefusal = false;
    for (const f of allFiles) {
      const rel = relOf(f);
      if (rel.endsWith('.test.ts')) continue;
      if (!rel.startsWith('apps/desktop/src/')) continue;
      if (readFileSync(f, 'utf8').includes('budget-unported')) {
        foundRefusal = true;
        fail('desktop-dispatch', `${rel} still names 'budget-unported' — #293 ported the budget gate; the refusal must be gone`);
      }
    }
    if (!foundRefusal) ok();

    const text = readFileSync(join(root, dispatcherFile), 'utf8');
    const fetchIdx = text.indexOf('fetchItemsByNumber(');
    const checkIdx = text.indexOf('budget.check(');
    const launchIdx = text.indexOf('launch.launch(');
    if (fetchIdx === -1 || checkIdx === -1 || launchIdx === -1) {
      fail('desktop-dispatch', `${dispatcherFile} is missing fetchItemsByNumber(, budget.check(, or launch.launch( — the guard cannot compare an ordering that isn't there`);
    } else expect((fetchIdx < checkIdx && checkIdx < launchIdx), 'desktop-dispatch', `${dispatcherFile}'s own fetchItemsByNumber(/budget.check(/launch.launch( calls are out of order — expected fetchItemsByNumber( before budget.check( before launch.launch(`);
  }

  // pin: `main/dispatch/budget.ts`'s `BUDGET_VERDICTS` ↔ `bin/budget.mjs`'s `verdict()`, both directions
  {
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

    // pin: the gate never spawns a script, so no copied budget.mjs can go stale
    const gateText = readFileSync(join(root, budgetGateFile), 'utf8');
    expect(!/main\/platform\/node|parseNodeCommand/.test(gateText), 'desktop-dispatch', `${budgetGateFile} imports main/platform/node or parseNodeCommand — the budget gate runs in-process and never spawns commands.budget`);
  }

  // --- ledger.record( is called under main/ only from dispatch/dispatcher.ts, only after a
  // launch returns ok. ---
  {
    let found = false;
    let sawDispatcher = false;
    for (const f of allFiles) {
      const rel = relOf(f);
      if (rel.endsWith('.test.ts')) continue;
      if (!rel.startsWith('apps/desktop/src/main/')) continue;
      const text = readFileSync(f, 'utf8');
      if (!/\.record\s*\(/.test(text)) continue;
      // Narrowed to the ledger's own call shape, never a bare `.record(` that could match an unrelated method.
      if (!/ledger\.record\s*\(/.test(text)) continue;
      if (rel === dispatcherFile) {
        sawDispatcher = true;
      } else {
        found = true;
        fail('desktop-dispatch', `${rel} calls ledger.record( — only ${dispatcherFile} may, after a launch actually returns ok`);
      }
    }
    if (!sawDispatcher) fail('desktop-dispatch', `${dispatcherFile} never calls ledger.record( — the guard cannot pass vacuously`);
    else if (!found) ok();
  }

  // pin: `main/dispatch/dispatcher.ts`'s `DISPATCH_PROMPT`/`REFRESH_PROMPT` ↔ `pipeline/SKILL.md`'s "Dispatching" block, both directions
  {
    const dispatcherText = readFileSync(join(root, dispatcherFile), 'utf8');
    const dispatchPromptMatch = /DISPATCH_PROMPT\s*=\s*'([^']*)'/.exec(dispatcherText);
    const refreshPromptMatch = /REFRESH_PROMPT\s*=\s*'([^']*)'/.exec(dispatcherText);
    if (!dispatchPromptMatch || !refreshPromptMatch) {
      fail('desktop-dispatch', `${dispatcherFile} is missing DISPATCH_PROMPT or REFRESH_PROMPT as a single-quoted string literal`);
    } else {
      const skillText = pipelineSkillText();
      expect(skillText.includes(dispatchPromptMatch[1]), 'desktop-dispatch', `${dispatcherFile}'s DISPATCH_PROMPT is not byte-identical to any text in pipeline/SKILL.md's Dispatching block`);
      expect(skillText.includes(refreshPromptMatch[1]), 'desktop-dispatch', `${dispatcherFile}'s REFRESH_PROMPT is not byte-identical to any text in pipeline/SKILL.md's Dispatching block`);
    }
  }

  // --- .observations is read under main/ only by dispatchable.ts's observableFrom, which
  // strips the one report-only kind before anything may act on the rest. ---
  {
    let sawObservableFrom = false;
    let found = false;
    for (const f of allFiles) {
      const rel = relOf(f);
      if (!rel.startsWith('apps/desktop/src/main/') || rel.endsWith('.test.ts')) continue;
      const text = readFileSync(f, 'utf8');
      if (!/\.observations\b/.test(text)) continue;
      if (rel === dispatchableFile) {
        sawObservableFrom = true;
      } else {
        found = true;
        fail('desktop-dispatch', `${rel} reads '.observations' directly — only ${dispatchableFile} (observableFrom) may`);
      }
    }
    if (!sawObservableFrom) fail('desktop-dispatch', `${dispatchableFile} never reads '.observations' — the gate itself must`);
    else if (!found) ok();
  }

  // --- dispatcher.ts wires the observation write only past the owner gate — never before
  // the owner !== 'app' stand-down, which could write while the cockpit holds dispatch. ---
  {
    const text = readFileSync(join(root, dispatcherFile), 'utf8');
    const ownerGateIdx = text.indexOf("owner !== 'app'");
    // The call-site usage, never the interface's own field declaration above it.
    const writeIdx = text.indexOf('deps.writeObservation');
    if (ownerGateIdx === -1) {
      fail('desktop-dispatch', `${dispatcherFile} no longer checks owner !== 'app' — the guard cannot compare an ordering that isn't there`);
    } else if (writeIdx === -1) {
      fail('desktop-dispatch', `${dispatcherFile} never references deps.writeObservation — the observation pass wiring is missing`);
    } else expect(!(writeIdx < ownerGateIdx), 'desktop-dispatch', `${dispatcherFile} references deps.writeObservation before its own owner !== 'app' stand-down — the observation pass must run only once this app owns dispatch`);
  }

  // pin: `main/dispatch/observation.ts`'s comment templates ↔ `FORMATS.md`'s "Approval withdrawn"/"Rebase required" fences and `TICK-PROSE.md`'s zero-diff and integration-red escalation fences
  {
    const observationFile = `${mainDispatchDir}/observation.ts`;
    const observationText = readFileSync(join(root, observationFile), 'utf8');

    const fenceTextOf = (docText: string, anchor: string): string | null => {
      const anchorIdx = docText.indexOf(anchor);
      if (anchorIdx === -1) return null;
      const fenceStart = docText.indexOf('```', anchorIdx);
      if (fenceStart === -1) return null;
      const fenceEnd = docText.indexOf('```', fenceStart + 3);
      if (fenceEnd === -1) return null;
      return docText.slice(fenceStart + 3, fenceEnd).trim();
    };

    // Splits on `<placeholder>` tokens and strips surrounding backticks — a JS template
    // literal escapes those, so a fragment ending on a bare backtick would never match. ---
    const fenceLiteralsOf = (fence: string): readonly string[] =>
      fence
        .split('\n')
        .flatMap((line) => line.split(/<[^>]+>/))
        .map((s) => s.trim().replace(/^`+/, '').replace(/`+$/, '').trim())
        .filter((s) => s.length >= 4);

    const docsText = pipelineDocsText();
    const skillText = pipelineSkillText();
    const fences: { readonly name: string; readonly fence: string | null }[] = [
      { name: `"Approval withdrawn" (FORMATS.md)`, fence: fenceTextOf(docsText, '### Approval withdrawn') },
      { name: `"Rebase required" (FORMATS.md)`, fence: fenceTextOf(docsText, '### Rebase required') },
      { name: `"Approval withdrawn" escalation variant (FORMATS.md)`, fence: fenceTextOf(docsText, 'Approval withdrawn — escalation variant') },
      { name: 'the per-SHA cap escalation (TICK-PROSE.md)', fence: fenceTextOf(skillText, 'Per-SHA cap.') },
      { name: 'the zero-diff escalation (TICK-PROSE.md)', fence: fenceTextOf(skillText, 'zero-diff-<pr>.md') },
      { name: 'the integration-red escalation (TICK-PROSE.md)', fence: fenceTextOf(skillText, 'integration-red-escalation-<pr>.md') },
    ];

    let violated = false;
    for (const { name, fence } of fences) {
      if (fence === null) {
        violated = true;
        fail('desktop-dispatch', `could not find the ${name} fence to compare ${observationFile} against`);
        continue;
      }
      for (const literal of fenceLiteralsOf(fence)) {
        if (!observationText.includes(literal)) {
          violated = true;
          fail('desktop-dispatch', `${observationFile} is missing '${literal}' — drifted from the ${name} fence`);
        }
      }
    }
    if (!violated) ok();
  }

  // --- .autoApprovals is read under main/ only by dispatchable.ts's autoApprovableFrom —
  // the same rail .actionable and .observations already hold. ---
  {
    const autoPlanFile = `${mainDispatchDir}/auto-plan.ts`;
    let sawAutoApprovableFrom = false;
    let found = false;
    for (const f of allFiles) {
      const rel = relOf(f);
      if (!rel.startsWith('apps/desktop/src/main/') || rel.endsWith('.test.ts')) continue;
      const text = readFileSync(f, 'utf8');
      if (!/\.autoApprovals\b/.test(text)) continue;
      if (rel === dispatchableFile) {
        sawAutoApprovableFrom = true;
      } else {
        found = true;
        fail('desktop-dispatch', `${rel} reads '.autoApprovals' directly — only ${dispatchableFile} (autoApprovableFrom) may`);
      }
    }
    if (!sawAutoApprovableFrom) fail('desktop-dispatch', `${dispatchableFile} never reads '.autoApprovals' — the gate itself must`);
    else if (!found) ok();

    // --- auto-plan.ts gates on ownership.kind === 'app', never a claim scope — the auto-plan
    // swap fires only while this app owns the repository outright. ---
    if (mainDispatchFiles.some((f) => relOf(f) === autoPlanFile)) {
      const autoPlanText = readFileSync(join(root, autoPlanFile), 'utf8');
      const ownershipIdx = autoPlanText.indexOf('deps.readOwnership(');
      const approveIdx = autoPlanText.indexOf('deps.autoApprove(');
      if (ownershipIdx === -1) {
        fail('desktop-dispatch', `${autoPlanFile} never calls deps.readOwnership( — the owner resolution this whole module rests on is missing`);
      } else if (!autoPlanText.includes("ownership.kind !== 'app'") && !autoPlanText.includes("ownership.kind === 'app'")) {
        fail('desktop-dispatch', `${autoPlanFile} never gates on ownership.kind being 'app' — it cannot be reading the ownership record for the right thing`);
      } else expect(!(approveIdx === -1 || ownershipIdx > approveIdx), 'desktop-dispatch', `${autoPlanFile}'s deps.readOwnership( call must precede its deps.autoApprove( call in source order`);
    } else {
      fail('desktop-dispatch', `${autoPlanFile} does not exist — the guard cannot pass vacuously`);
    }
  }

  // --- main/ipc.ts passes launch: stageLauncher and never launch: null — a null launcher was
  // the honest placeholder state before the real StageLauncher existed. ---
  {
    const ipcFile = allFiles.find((f) => relOf(f) === 'apps/desktop/src/main/ipc.ts');
    if (!ipcFile) {
      fail('desktop-dispatch', 'apps/desktop/src/main/ipc.ts does not exist');
    } else {
      const text = readFileSync(ipcFile, 'utf8');
      if (/launch:\s*null\b/.test(text)) {
        fail('desktop-dispatch', "apps/desktop/src/main/ipc.ts still passes 'launch: null' — the real StageLauncher must be wired");
      } else expect(/launch:\s*stageLauncher\b/.test(text), 'desktop-dispatch', "apps/desktop/src/main/ipc.ts does not pass 'launch: stageLauncher'");
    }
  }

  // --- utils/stage/handback-text.ts's QUESTIONS FOR HUMAN:/BLOCKED: prefixes each appear verbatim in
  // the pipeline skill's own completion-handling text, both sides of the same contract. ---
  {
    const handbackFile = allFiles.find((f) => relOf(f) === 'apps/desktop/src/utils/stage/handback-text.ts');
    if (!handbackFile) {
      fail('desktop-dispatch', 'apps/desktop/src/utils/stage/handback-text.ts does not exist');
    } else {
      const text = readFileSync(handbackFile, 'utf8');
      const questionsMatch = /QUESTIONS_PREFIX\s*=\s*'([^']+)'/.exec(text);
      const blockedMatch = /BLOCKED_PREFIX\s*=\s*'([^']+)'/.exec(text);
      if (!questionsMatch || !blockedMatch) {
        fail('desktop-dispatch', "apps/desktop/src/utils/stage/handback-text.ts does not declare both QUESTIONS_PREFIX and BLOCKED_PREFIX as string literals");
      } else {
        const skillText = pipelineSkillText();
        const questionsOk = skillText.includes(questionsMatch[1]);
        const blockedOk = skillText.includes(blockedMatch[1]);
        if (!questionsOk) fail('desktop-dispatch', `handback-text.ts's QUESTIONS_PREFIX ('${questionsMatch[1]}') never appears verbatim in the pipeline skill text`);
        if (!blockedOk) fail('desktop-dispatch', `handback-text.ts's BLOCKED_PREFIX ('${blockedMatch[1]}') never appears verbatim in the pipeline skill text`);
        if (questionsOk && blockedOk) ok();
      }
    }
  }

  // --- No file under main/stage/ calls --force or passes 'force' to dismiss — worktree removal
  // on a stage hand-back never forces, so it fails toward keeping work. ---
  {
    const stageDir = 'apps/desktop/src/main/stage';
    const stageFiles = allFiles.filter((f) => relOf(f).startsWith(`${stageDir}/`) && !relOf(f).endsWith('.test.ts'));
    let found = false;
    for (const f of stageFiles) {
      const rel = relOf(f);
      const text = readFileSync(f, 'utf8');
      if (text.includes('--force') || /dismiss\([^)]*'force'/.test(text)) {
        found = true;
        fail('desktop-dispatch', `${rel} forces a worktree removal — a stage hand-back must fail toward keeping the worktree`);
      }
    }
    if (!found) ok();
  }
}
