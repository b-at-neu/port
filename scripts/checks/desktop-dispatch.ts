import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipelineSkillText, root, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// Operator control over dispatch (issue 110) and the app's own dispatcher
// (#265) — thirteen mechanical rails, dependency-free and regex-based, in
// the shape of desktop-actions.ts's and desktop-writes.ts's own guards.
export default async function ({ fail, ok }: Reporter) {
  const sharedDispatchDir = 'apps/desktop/src/shared/dispatch';
  const mainDispatchDir = 'apps/desktop/src/main/dispatch';
  const resolveFile = `${mainDispatchDir}/resolve.ts`;
  const haltFile = `${mainDispatchDir}/halt.ts`;
  const dispatcherFile = `${mainDispatchDir}/dispatcher.ts`;
  const turnFile = `${mainDispatchDir}/turn.ts`;
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

  // --- dispatcher.ts names commands.budget ------------------------------------
  // guard(#265): the budget refusal silently dropped — a repository with
  // commands.budget set would then dispatch with no cost ceiling enforced.
  {
    const text = readFileSync(join(root, dispatcherFile), 'utf8');
    if (!text.includes('commands.budget')) {
      fail('desktop-dispatch', `${dispatcherFile} never names 'commands.budget' — the budget refusal this ticket adds is missing`);
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
}
