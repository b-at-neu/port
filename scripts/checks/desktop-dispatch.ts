import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// Operator control over dispatch (issue 110) — seven mechanical rails,
// dependency-free and regex-based, in the shape of desktop-actions.ts's and
// desktop-writes.ts's own guards.
export default async function ({ fail, ok }: Reporter) {
  const sharedDispatchDir = 'apps/desktop/src/shared/dispatch';
  const mainDispatchDir = 'apps/desktop/src/main/dispatch';
  const resolveFile = `${mainDispatchDir}/resolve.ts`;
  const haltFile = `${mainDispatchDir}/halt.ts`;
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

  // --- In halt.ts, the first drain.set( precedes the first applyItemAction( --
  // guard(#110): the ordering the feature's correctness rests on — resetting
  // labels before the drain write is confirmed would only re-dispatch
  // everything this call was meant to stop.
  {
    const text = readFileSync(join(root, haltFile), 'utf8');
    const setIdx = text.indexOf('drain.set(');
    const applyIdx = text.indexOf('applyItemAction(');
    if (setIdx === -1) {
      fail('desktop-dispatch', `${haltFile} never calls drain.set( — halt must drain before it stops anything`);
    } else if (applyIdx === -1) {
      fail('desktop-dispatch', `${haltFile} never calls applyItemAction( — the guard cannot compare an ordering that isn't there`);
    } else if (setIdx > applyIdx) {
      fail('desktop-dispatch', `${haltFile} calls applyItemAction( before drain.set( — the drain write must be confirmed first`);
    } else {
      ok();
    }
  }
}
