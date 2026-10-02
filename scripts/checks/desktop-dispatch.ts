import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipelineDocsText, pipelineSkillText, root, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// Operator control over dispatch (issue 110) and the app's own dispatcher
// (#265) — thirteen mechanical rails, dependency-free and regex-based, in
// the shape of desktop-actions.ts's and desktop-writes.ts's own guards.
// #293 adds the budget gate's own rails alongside them.
export default async function ({ fail, ok }: Reporter) {
  const sharedDispatchDir = 'apps/desktop/src/shared/dispatch';
  const mainDispatchDir = 'apps/desktop/src/main/dispatch';
  const resolveFile = `${mainDispatchDir}/resolve.ts`;
  const haltFile = `${mainDispatchDir}/halt.ts`;
  const dispatcherFile = `${mainDispatchDir}/dispatcher.ts`;
  const turnFile = `${mainDispatchDir}/turn.ts`;
  const budgetFile = `${mainDispatchDir}/budget.ts`;
  const budgetGateFile = `${mainDispatchDir}/budget-gate.ts`;
  const budgetScriptPath = join(root, 'plugins/port/bin/budget.mjs');
  const dispatchableFile = 'apps/desktop/src/main/tick/dispatchable.ts';
  const trajectoryFile = 'apps/desktop/src/main/trajectory/log.ts';

  const srcDir = join(root, 'apps/desktop/src');
  const allFiles = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  const sharedDispatchFiles = allFiles.filter((f) => relOf(f).startsWith(`${sharedDispatchDir}/`));
  const mainDispatchFiles = allFiles.filter((f) => relOf(f).startsWith(`${mainDispatchDir}/`));

  // --- main/dispatch/ has source files ---------------------------------------
  // guard(#110): the directory this whole ticket adds being deleted with
  // nothing to catch it.
  if (mainDispatchFiles.filter((f) => !relOf(f).endsWith('.test.ts')).length === 0) {
    fail('desktop-dispatch', `${mainDispatchDir} has no source files — the guard cannot pass vacuously if the directory is deleted`);
  } else {
    ok();
  }

  // --- shared/dispatch/ compiles under typecheck:web -------------------------
  // guard(#110): the pure drain/halt contract losing its typecheck:web
  // compatibility, the same rail shared/actions/ already holds.
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

  // --- running/alive/isLive banned under shared/dispatch/ and main/dispatch/ -
  // guard(#110): a local transcript's recency, or an attached agent's
  // presence, reported as liveness rather than an attachment fact this app
  // cannot actually stop.
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

  // --- The gate rail: .actionable is read under main/ only where documented --
  // guard(#110): a future dispatcher reading report.actionable directly,
  // bypassing dispatchableFrom — the one function the drain gate is meant to
  // funnel through. main/trajectory/log.ts is a pre-existing, documented
  // reporting-only reader (its own trajectory event, issue 111), never a
  // dispatch path, so it is allowed alongside dispatchable.ts itself.
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

  // --- The literal gate: 'open' appears exactly once under main/dispatch/ ----
  // guard(#110): a second failure path constructing its own open state
  // instead of reusing the one place it is defined, so a new arm added later
  // cannot quietly fail open by copying the literal.
  {
    let count = 0;
    for (const f of mainDispatchFiles) {
      if (relOf(f).endsWith('.test.ts')) continue;
      const text = readFileSync(f, 'utf8');
      count += (text.match(/gate:\s*'open'/g) ?? []).length;
    }
    if (count !== 1) {
      fail('desktop-dispatch', `the literal "gate: 'open'" appears ${count} times under ${mainDispatchDir} — expected exactly 1`);
    } else {
      ok();
    }
  }

  // --- resolve.ts validates against DISPATCH_COMMANDS by name ----------------
  // guard(#110): a retyped command list silently drifting from
  // shared/dispatch/types.ts's own DISPATCH_COMMANDS.
  {
    const text = readFileSync(join(root, resolveFile), 'utf8');
    if (!/DISPATCH_COMMANDS/.test(text)) {
      fail('desktop-dispatch', `${resolveFile} never references DISPATCH_COMMANDS — command validation must resolve it by name, never a retyped list`);
    } else if (/\[\s*'drain'\s*,\s*'resume'\s*,\s*'halt'\s*\]/.test(text)) {
      fail('desktop-dispatch', `${resolveFile} retypes the command list as a literal array instead of validating against DISPATCH_COMMANDS`);
    } else {
      ok();
    }
  }

  // --- In halt.ts, drain.set( precedes stopFor(, which precedes applyItemAction( --
  // guard(#110, #265): the ordering the feature's correctness rests on —
  // resetting labels before the drain write is confirmed would only
  // re-dispatch everything this call was meant to stop, and resetting a
  // label before the dispatcher's own agent is asked to stop would leave an
  // app-dispatched agent running past the point its label says it is gone.
  {
    const text = readFileSync(join(root, haltFile), 'utf8');
    const setIdx = text.indexOf('drain.set(');
    // `stopFor?.(` (optional chaining) counts the same as a bare `stopFor(`.
    const stopForMatch = /stopFor\??\.?\(/.exec(text);
    const stopForIdx = stopForMatch ? stopForMatch.index : -1;
    const applyIdx = text.indexOf('applyItemAction(');
    if (setIdx === -1) {
      fail('desktop-dispatch', `${haltFile} never calls drain.set( — halt must drain before it stops anything`);
    } else if (stopForIdx === -1) {
      fail('desktop-dispatch', `${haltFile} never calls stopFor( — the dispatcher's own per-item stop must run before each label reset`);
    } else if (applyIdx === -1) {
      fail('desktop-dispatch', `${haltFile} never calls applyItemAction( — the guard cannot compare an ordering that isn't there`);
    } else if (!(setIdx < stopForIdx && stopForIdx < applyIdx)) {
      fail('desktop-dispatch', `${haltFile}'s own drain.set(/stopFor(/applyItemAction( calls are out of order — expected drain.set( before stopFor( before applyItemAction(`);
    } else {
      ok();
    }
  }

  // --- dispatcher.ts calls readGateClaim( and names 'dispatch' ---------------
  // guard(#265): the composition root silently losing its own claim read, or
  // reading it for a scope it never actually checks against.
  {
    const text = readFileSync(join(root, dispatcherFile), 'utf8');
    if (!/\breadGateClaim\s*\(/.test(text)) {
      fail('desktop-dispatch', `${dispatcherFile} never calls readGateClaim( — the owner resolution this whole module rests on is missing`);
    } else if (!text.includes("'dispatch'")) {
      fail('desktop-dispatch', `${dispatcherFile} never names the 'dispatch' scope — it cannot be reading the claim for the right thing`);
    } else {
      ok();
    }
  }

  // --- budget-unported is gone; the gate runs instead -------------------------
  // guard(#293): #265's refusal reverting instead of staying ported — the
  // literal reason string must appear nowhere, and the dispatcher's own
  // ordering (re-read, then gate, then send) must hold so a stale candidate
  // is never gated and a gated-in candidate is never skipped.
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
    const sendIdx = text.indexOf('store.send(');
    if (fetchIdx === -1 || checkIdx === -1 || sendIdx === -1) {
      fail('desktop-dispatch', `${dispatcherFile} is missing fetchItemsByNumber(, budget.check(, or store.send( — the guard cannot compare an ordering that isn't there`);
    } else if (!(fetchIdx < checkIdx && checkIdx < sendIdx)) {
      fail('desktop-dispatch', `${dispatcherFile}'s own fetchItemsByNumber(/budget.check(/store.send( calls are out of order — expected fetchItemsByNumber( before budget.check( before store.send(`);
    } else {
      ok();
    }
  }

  // --- pin: BUDGET_VERDICTS ↔ budget.mjs's own verdict(), both directions ----
  // guard(#293): the app's own gate reading a verdict the script can never
  // produce, or missing one it does — `budgetRoute` would then either throw
  // on something real or silently treat it as unreachable.
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
      if (onlyInApp.length > 0 || onlyInScript.length > 0) {
        fail('desktop-dispatch', `${budgetFile}'s BUDGET_VERDICTS (${[...appVerdicts].join(', ')}) and bin/budget.mjs's verdicts (${[...scriptVerdicts].join(', ')}) disagree`);
      } else {
        ok();
      }
    }

    // --- pin: sessionLogName(BUDGET_SESSION) !== null -------------------------
    // guard(#293): BUDGET_SESSION drifting to a name the script's own
    // validator rejects, wedging the gate shut on every call.
    // pin: `main/dispatch/budget.ts`'s `BUDGET_SESSION` ↔ `bin/budget.mjs`'s `sessionLogName` accepting it
    const sessionMatch = /BUDGET_SESSION\s*=\s*'([^']+)'/.exec(budgetText);
    if (!sessionMatch) {
      fail('desktop-dispatch', `${budgetFile} has no 'BUDGET_SESSION = ...' assignment`);
    } else if (mod.sessionLogName(sessionMatch[1]) === null) {
      fail('desktop-dispatch', `${budgetFile}'s BUDGET_SESSION ('${sessionMatch[1]}') is rejected by bin/budget.mjs's own sessionLogName — the gate would die on every call`);
    } else {
      ok();
    }

    // --- pin: OUTDATED_SCRIPT_SENTINEL matches budget.mjs's own die() template -
    // guard(#293): the sentinel drifting from the wording an older script's
    // unrecognized-argument failure produces, so a pre-`--session` copy is
    // never actually detected as outdated. The rendered message is never a
    // literal in the script's own source (the argument is interpolated), so
    // this pins the shared prefix both sides must agree on.
    // pin: `main/dispatch/budget.ts`'s `OUTDATED_SCRIPT_SENTINEL` ↔ `bin/budget.mjs`'s unrecognized-argument `die()` template
    const sentinelMatch = /OUTDATED_SCRIPT_SENTINEL\s*=\s*"([^"]+)"/.exec(budgetText);
    const scriptText = readFileSync(budgetScriptPath, 'utf8');
    const diePrefix = "unrecognized argument '";
    if (!sentinelMatch) {
      fail('desktop-dispatch', `${budgetFile} has no 'OUTDATED_SCRIPT_SENTINEL = "..."' assignment`);
    } else if (!scriptText.includes(`die(\`${diePrefix}`)) {
      fail('desktop-dispatch', `bin/budget.mjs no longer defines the unrecognized-argument die() template this sentinel pins against`);
    } else if (!sentinelMatch[1].startsWith(diePrefix)) {
      fail('desktop-dispatch', `${budgetFile}'s OUTDATED_SCRIPT_SENTINEL ('${sentinelMatch[1]}') does not match bin/budget.mjs's own unrecognized-argument wording ('${diePrefix}…')`);
    } else {
      ok();
    }
  }

  // --- pin: bin/budget.mjs contains SCRIPT_FAIL_PREFIX ------------------------
  // guard(#293): budget-gate.ts reading a FAIL line prefix the shipped
  // script no longer actually emits, so every real failure reads as an
  // unparseable platform error instead.
  // pin: `main/reclaimer/report.ts`'s `SCRIPT_FAIL_PREFIX` ↔ `bin/budget.mjs`'s own `die()`
  {
    const scriptText = readFileSync(budgetScriptPath, 'utf8');
    const gateText = readFileSync(join(root, budgetGateFile), 'utf8');
    const prefixMatch = /SCRIPT_FAIL_PREFIX\s*=\s*'([^']+)'/.exec(readFileSync(join(root, 'apps/desktop/src/main/reclaimer/report.ts'), 'utf8'));
    if (!prefixMatch) {
      fail('desktop-dispatch', `apps/desktop/src/main/reclaimer/report.ts has no 'SCRIPT_FAIL_PREFIX = ...' assignment`);
    } else if (!scriptText.includes(prefixMatch[1])) {
      fail('desktop-dispatch', `bin/budget.mjs never emits '${prefixMatch[1]}' — SCRIPT_FAIL_PREFIX would never match a real failure`);
    } else if (!gateText.includes('SCRIPT_FAIL_PREFIX')) {
      fail('desktop-dispatch', `${budgetGateFile} never imports SCRIPT_FAIL_PREFIX — it must reuse the reclaimer's own constant, never a retyped literal`);
    } else {
      ok();
    }
  }

  // --- ledger.record( is called under main/ only from dispatch/dispatcher.ts -
  // guard(#265): a second caller recording a dispatch before confirmStarted
  // actually saw the task — the whole point of confirm-before-record.
  {
    let found = false;
    let sawDispatcher = false;
    for (const f of allFiles) {
      const rel = relOf(f);
      if (rel.endsWith('.test.ts')) continue;
      if (!rel.startsWith('apps/desktop/src/main/')) continue;
      const text = readFileSync(f, 'utf8');
      if (!/\.record\s*\(/.test(text)) continue;
      // Narrowed to the ledger's own call shape (`<name>.record(repoId,
      // number)`), never a bare `.record(` match that would also catch an
      // unrelated method of the same name on some other object.
      if (!/ledger\.record\s*\(/.test(text)) continue;
      if (rel === dispatcherFile) {
        sawDispatcher = true;
      } else {
        found = true;
        fail('desktop-dispatch', `${rel} calls ledger.record( — only ${dispatcherFile} may, after confirmStarted actually sees the task`);
      }
    }
    if (!sawDispatcher) fail('desktop-dispatch', `${dispatcherFile} never calls ledger.record( — the guard cannot pass vacuously`);
    else if (!found) ok();
  }

  // --- DISPATCHER_MODEL is declared once --------------------------------------
  // guard(#265): a second declaration drifting from the first — the model
  // every dispatch turn uses must come from exactly one place.
  {
    const text = readFileSync(join(root, turnFile), 'utf8');
    const count = (text.match(/\bDISPATCHER_MODEL\s*=/g) ?? []).length;
    if (count !== 1) {
      fail('desktop-dispatch', `${turnFile} declares DISPATCHER_MODEL ${String(count)} times — expected exactly 1`);
    } else {
      ok();
    }
  }

  // --- pin: turn.ts's two prompts ↔ SKILL.md's Dispatching block -------------
  // guard(#265): the dispatcher's own prompt text drifting from the cockpit's
  // — both must send the identical instruction to a stage agent regardless
  // of which one dispatched it.
  // pin: `main/dispatch/turn.ts`'s `DISPATCH_PROMPT`/`REFRESH_PROMPT` ↔ `pipeline/SKILL.md`'s "Dispatching" block, both directions
  {
    const turnText = readFileSync(join(root, turnFile), 'utf8');
    const dispatchPromptMatch = /DISPATCH_PROMPT\s*=\s*'([^']*)'/.exec(turnText);
    const refreshPromptMatch = /REFRESH_PROMPT\s*=\s*'([^']*)'/.exec(turnText);
    if (!dispatchPromptMatch || !refreshPromptMatch) {
      fail('desktop-dispatch', `${turnFile} is missing DISPATCH_PROMPT or REFRESH_PROMPT as a single-quoted string literal`);
    } else {
      const skillText = pipelineSkillText();
      if (!skillText.includes(dispatchPromptMatch[1])) {
        fail('desktop-dispatch', `${turnFile}'s DISPATCH_PROMPT is not byte-identical to any text in pipeline/SKILL.md's Dispatching block`);
      } else {
        ok();
      }
      if (!skillText.includes(refreshPromptMatch[1])) {
        fail('desktop-dispatch', `${turnFile}'s REFRESH_PROMPT is not byte-identical to any text in pipeline/SKILL.md's Dispatching block`);
      } else {
        ok();
      }
    }
  }

  // --- #292: .observations is read under main/ only by dispatchable.ts's -----
  // observableFrom
  // guard(#292): a future caller reading report.observations directly,
  // bypassing observableFrom — the one function that strips the two
  // report-only kinds (refresh-deferred, withdraw-unverifiable) before
  // anything may act on the rest.
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

  // --- #292: dispatcher.ts wires the observation write only past the owner ---
  // gate
  // guard(#292): the write-bearing observation pass being wired before the
  // owner !== 'app' stand-down, which would let this app write a
  // repository's observations while the cockpit (or nobody) actually holds
  // dispatch.
  {
    const text = readFileSync(join(root, dispatcherFile), 'utf8');
    const ownerGateIdx = text.indexOf("owner !== 'app'");
    // `deps.writeObservation` — the call-site usage, never the interface's
    // own `writeObservation:` field declaration above it (which the gate
    // naturally precedes, telling us nothing about ordering).
    const writeIdx = text.indexOf('deps.writeObservation');
    if (ownerGateIdx === -1) {
      fail('desktop-dispatch', `${dispatcherFile} no longer checks owner !== 'app' — the guard cannot compare an ordering that isn't there`);
    } else if (writeIdx === -1) {
      fail('desktop-dispatch', `${dispatcherFile} never references deps.writeObservation — the observation pass wiring is missing`);
    } else if (writeIdx < ownerGateIdx) {
      fail('desktop-dispatch', `${dispatcherFile} references deps.writeObservation before its own owner !== 'app' stand-down — the observation pass must run only once this app owns dispatch`);
    } else {
      ok();
    }
  }

  // --- pin: observation.ts's comment templates ↔ FORMATS.md/TICK-PROSE.md ----
  // fences
  // guard(#292): a comment template drifting from the fence FORMATS.md or
  // TICK-PROSE.md documents, so what a human (or revise-agent/review-agent)
  // reads on the pull request no longer matches what either doc promises.
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

    // Splits on `<placeholder>` tokens and strips the backticks a placeholder
    // is usually wrapped in — a JS template literal escapes those (`\``),
    // so a fragment ending or starting on a bare backtick would never match
    // the escaped form in source text.
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
}
