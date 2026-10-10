import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipelineDocsText, pipelineSkillText, root, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// Operator control over dispatch and the app's own dispatch loop, plus the budget gate's own
// rails — mechanical, dependency-free, regex-based rails.
export default async function ({ expect, fail, ok }: Reporter) {
  const sharedDispatchDir = 'apps/desktop/src/shared/dispatch';
  const mainDispatchDir = 'apps/desktop/src/main/dispatch';
  const resolveFile = `${mainDispatchDir}/resolve.ts`;
  const haltFile = `${mainDispatchDir}/halt.ts`;
  const dispatcherFile = `${mainDispatchDir}/dispatcher.ts`;
  const budgetFile = `${mainDispatchDir}/budget.ts`;
  const budgetGateFile = `${mainDispatchDir}/budget-gate.ts`;
  const budgetScriptPath = join(root, 'plugins/port/bin/budget.mjs');
  const dispatchableFile = 'apps/desktop/src/main/tick/dispatchable.ts';
  const trajectoryFile = 'apps/desktop/src/main/trajectory/log.ts';

  const srcDir = join(root, 'apps/desktop/src');
  const allFiles = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  const sharedDispatchFiles = allFiles.filter((f) => relOf(f).startsWith(`${sharedDispatchDir}/`));
  const mainDispatchFiles = allFiles.filter((f) => relOf(f).startsWith(`${mainDispatchDir}/`));

  // --- main/dispatch/ has source files, so nothing below passes vacuously once deleted. ---
  expect(!(mainDispatchFiles.filter((f) => !relOf(f).endsWith('.test.ts')).length === 0), 'desktop-dispatch', `${mainDispatchDir} has no source files — the guard cannot pass vacuously if the directory is deleted`);

  // --- shared/dispatch/ compiles under typecheck:web, the same rail shared/actions/ holds. ---
  {
    let found = false;
    for (const f of sharedDispatchFiles) {
      const text = readFileSync(f, 'utf8');
      if (/from\s+'node:/.test(text) || /from\s+'.*\/main\//.test(text)) {
        found = true;
        fail('desktop-dispatch', `${relOf(f)} imports a node: builtin or a main/ path — shared/dispatch/ must compile under typecheck:web`);
      }
    }
    if (!found) ok();
  }

  // --- running/alive/isLive banned under shared/dispatch/ and main/dispatch/ — never report
  // a recency or attachment fact as liveness. ---
  {
    let found = false;
    for (const f of [...sharedDispatchFiles, ...mainDispatchFiles]) {
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
    } else expect(!/\[\s*'run'\s*,\s*'drain'\s*,\s*'pause'\s*,\s*'halt'\s*\]/.test(text), 'desktop-dispatch', `${resolveFile} retypes the command list as a literal array instead of validating against DISPATCH_COMMANDS`);
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

    // pin: `main/dispatch/budget.ts`'s `BUDGET_SESSION` ↔ `bin/budget.mjs`'s `sessionLogName` accepting it
    const sessionMatch = /BUDGET_SESSION\s*=\s*'([^']+)'/.exec(budgetText);
    if (!sessionMatch) {
      fail('desktop-dispatch', `${budgetFile} has no 'BUDGET_SESSION = ...' assignment`);
    } else expect(!(mod.sessionLogName(sessionMatch[1]) === null), 'desktop-dispatch', `${budgetFile}'s BUDGET_SESSION ('${sessionMatch[1]}') is rejected by bin/budget.mjs's own sessionLogName — the gate would die on every call`);

    // pin: `main/dispatch/budget.ts`'s `OUTDATED_SCRIPT_SENTINEL` ↔ `bin/budget.mjs`'s unrecognized-argument `die()` template
    const sentinelMatch = /OUTDATED_SCRIPT_SENTINEL\s*=\s*"([^"]+)"/.exec(budgetText);
    const scriptText = readFileSync(budgetScriptPath, 'utf8');
    const diePrefix = "unrecognized argument '";
    if (!sentinelMatch) {
      fail('desktop-dispatch', `${budgetFile} has no 'OUTDATED_SCRIPT_SENTINEL = "..."' assignment`);
    } else if (!scriptText.includes(`die(\`${diePrefix}`)) {
      fail('desktop-dispatch', `bin/budget.mjs no longer defines the unrecognized-argument die() template this sentinel pins against`);
    } else expect(sentinelMatch[1].startsWith(diePrefix), 'desktop-dispatch', `${budgetFile}'s OUTDATED_SCRIPT_SENTINEL ('${sentinelMatch[1]}') does not match bin/budget.mjs's own unrecognized-argument wording ('${diePrefix}…')`);
  }

  // pin: `main/reclaimer/report.ts`'s `SCRIPT_FAIL_PREFIX` ↔ `bin/budget.mjs`'s own `die()`
  {
    const scriptText = readFileSync(budgetScriptPath, 'utf8');
    const gateText = readFileSync(join(root, budgetGateFile), 'utf8');
    const prefixMatch = /SCRIPT_FAIL_PREFIX\s*=\s*'([^']+)'/.exec(readFileSync(join(root, 'apps/desktop/src/main/reclaimer/report.ts'), 'utf8'));
    if (!prefixMatch) {
      fail('desktop-dispatch', `apps/desktop/src/main/reclaimer/report.ts has no 'SCRIPT_FAIL_PREFIX = ...' assignment`);
    } else if (!scriptText.includes(prefixMatch[1])) {
      fail('desktop-dispatch', `bin/budget.mjs never emits '${prefixMatch[1]}' — SCRIPT_FAIL_PREFIX would never match a real failure`);
    } else expect(gateText.includes('SCRIPT_FAIL_PREFIX'), 'desktop-dispatch', `${budgetGateFile} never imports SCRIPT_FAIL_PREFIX — it must reuse the reclaimer's own constant, never a retyped literal`);
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

  // pin: `main/dispatch/observation.ts`'s comment templates ↔ `FORMATS.md`'s "Approval withdrawn"/"Rebase required" fences and `TICK-PROSE.md`'s zero-diff escalation fence
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
      { name: 'the zero-diff escalation (TICK-PROSE.md)', fence: fenceTextOf(skillText, 'zero-diff-<pr>.md') },
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

  // --- main/stage/handback.ts's QUESTIONS FOR HUMAN:/BLOCKED: prefixes each appear verbatim in
  // the pipeline skill's own completion-handling text, both sides of the same contract. ---
  {
    const handbackFile = allFiles.find((f) => relOf(f) === 'apps/desktop/src/main/stage/handback.ts');
    if (!handbackFile) {
      fail('desktop-dispatch', 'apps/desktop/src/main/stage/handback.ts does not exist');
    } else {
      const text = readFileSync(handbackFile, 'utf8');
      const questionsMatch = /QUESTIONS_PREFIX\s*=\s*'([^']+)'/.exec(text);
      const blockedMatch = /BLOCKED_PREFIX\s*=\s*'([^']+)'/.exec(text);
      if (!questionsMatch || !blockedMatch) {
        fail('desktop-dispatch', "apps/desktop/src/main/stage/handback.ts does not declare both QUESTIONS_PREFIX and BLOCKED_PREFIX as string literals");
      } else {
        const skillText = pipelineSkillText();
        const questionsOk = skillText.includes(questionsMatch[1]);
        const blockedOk = skillText.includes(blockedMatch[1]);
        if (!questionsOk) fail('desktop-dispatch', `pipeline skill text never carries handback.ts's QUESTIONS_PREFIX ('${questionsMatch[1]}') verbatim`);
        if (!blockedOk) fail('desktop-dispatch', `pipeline skill text never carries handback.ts's BLOCKED_PREFIX ('${blockedMatch[1]}') verbatim`);
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
