import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, readJson, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// #94: the single-label operator actions (pause/resume/retry/gate) — six
// mechanical rails, dependency-free and regex-based, in the shape of
// desktop-claim.ts's and desktop-writes.ts's own guards. Reading these
// directories by explicit path (never walk('apps/'), which descends into
// node_modules).
export default async function ({ fail, ok }: Reporter) {
  const sharedActionsDir = 'apps/desktop/src/shared/actions';
  const mainActionsDir = 'apps/desktop/src/main/actions';
  const planFile = `${sharedActionsDir}/plan.ts`;
  const livenessFile = 'scripts/port-tick/liveness.ts';
  const projectFile = 'apps/desktop/src/shared/board/project.ts';

  const srcDir = join(root, 'apps/desktop/src');
  const allFiles = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  const sharedActionsFiles = allFiles.filter((f) => relOf(f).startsWith(`${sharedActionsDir}/`));
  const mainActionsFiles = allFiles.filter((f) => relOf(f).startsWith(`${mainActionsDir}/`));

  // --- shared/actions/ has source files -------------------------------------
  // guard(#94): the directory this whole ticket adds being deleted with
  // nothing to catch it.
  if (sharedActionsFiles.filter((f) => !relOf(f).endsWith('.test.ts')).length === 0) {
    fail('desktop-actions', `${sharedActionsDir} has no source files — the guard cannot pass vacuously if the directory is deleted`);
    return;
  }

  // --- RETRY_TRIGGER matches scripts/port-tick/liveness.ts, both directions
  // guard(#94): the operator retry button and the tick engine's own
  // automatic reset silently recovering to two different trigger labels —
  // checked both directions, keys and values, against
  // scripts/port-tick/liveness.ts's own RETRY_TRIGGER.
  // pin: `shared/actions/plan.ts`'s `RETRY_TRIGGER` ↔ `scripts/port-tick/liveness.ts`'s own `RETRY_TRIGGER`, both directions, keys and values
  {
    const planText = readFileSync(join(root, planFile), 'utf8');
    const livenessText = readFileSync(join(root, livenessFile), 'utf8');
    const planMatch = /RETRY_TRIGGER[^{]*\{([^}]*)\}/.exec(planText);
    const livenessMatch = /RETRY_TRIGGER\s*=\s*\{([^}]*)\}/.exec(livenessText);

    function pairsOf(body: string): Map<string, string> {
      const pairs = new Map<string, string>();
      for (const m of body.matchAll(/(\w+)\s*:\s*'([^']+)'/g)) pairs.set(m[1], m[2]);
      return pairs;
    }

    if (!planMatch) {
      fail('desktop-actions', `${planFile} has no 'RETRY_TRIGGER = {...}' object to compare`);
    } else if (!livenessMatch) {
      fail('desktop-actions', `${livenessFile} has no 'RETRY_TRIGGER = {...}' object to compare against`);
    } else {
      const planPairs = pairsOf(planMatch[1]);
      const livenessPairs = pairsOf(livenessMatch[1]);
      const allKeys = new Set([...planPairs.keys(), ...livenessPairs.keys()]);
      const mismatches = [...allKeys].filter((key) => planPairs.get(key) !== livenessPairs.get(key));
      if (mismatches.length > 0) {
        fail('desktop-actions', `${planFile}'s RETRY_TRIGGER and ${livenessFile}'s disagree on: ${mismatches.join(', ')}`);
      } else {
        ok();
      }
    }
  }

  // --- No file under shared/actions/ imports a node: builtin or a main/ path
  // guard(#94): the pure action-derivation layer losing its
  // `typecheck:web` compatibility, the same rail `shared/writes/types.ts`
  // and `shared/claim/types.ts` already hold.
  {
    let found = false;
    for (const f of sharedActionsFiles) {
      const text = readFileSync(f, 'utf8');
      if (/from\s+'node:/.test(text) || /from\s+'.*\/main\//.test(text) || /from\s+'\.\.\/\.\.\/main\//.test(text)) {
        found = true;
        fail('desktop-actions', `${relOf(f)} imports a node: builtin or a main/ path — shared/actions/ must compile under typecheck:web`);
      }
    }
    if (!found) ok();
  }

  // --- No non-test file under shared/actions/ or main/actions/ retypes a ----
  // guard(#94): a hand-typed display name drifting from a repository's own
  // label override, instead of resolving through the vocabulary as a
  // LabelKey. Checked only where key !== name (the same set
  // scripts/checks/labels.ts's own "Desktop app never retypes a resolved
  // label name" rail already scans the whole app for), since a single-word
  // label's name and its LabelKey coincide (e.g. 'ready' is both), which a
  // bare string-equality check cannot tell apart.
  {
    const mismatched = readJson('plugins/port/data/labels.json')
      .labels.filter((l: any) => l.key !== l.name)
      .map((l: any) => l.name);
    let found = false;
    for (const f of [...sharedActionsFiles, ...mainActionsFiles]) {
      const rel = relOf(f);
      if (rel.endsWith('.test.ts')) continue;
      const text = readFileSync(f, 'utf8');
      for (const name of mismatched) {
        if (text.includes(`'${name}'`) || text.includes(`"${name}"`)) {
          found = true;
          fail('desktop-actions', `${rel} contains the literal label name '${name}' — resolve it through the vocabulary as a LabelKey instead`);
        }
      }
    }
    if (!found) ok();
  }

  // --- applyLabels( is called under apps/desktop/src/ only from main/actions/
  // guard(#94): a third applyLabels caller diffusing the write chokepoint
  // built for issue 90, instead of main/actions/ staying the one composition
  // root. Issue 92 retired main/claim.ts's own pre-#94 grandfathered call
  // (docs/ENGINEERING.md named it "the second-caller debt issue 92 should
  // retire") by moving the write into main/actions/claim.ts — so
  // main/actions/ is now this rail's only caller, with no exception left.
  {
    const definitionFile = 'apps/desktop/src/main/writes/apply.ts';
    let found = false;
    let sawMainActions = false;
    for (const f of allFiles) {
      const rel = relOf(f);
      // main/writes/apply.ts is the function's own definition site, not a call.
      if (rel.endsWith('.test.ts') || rel === definitionFile) continue;
      const text = readFileSync(f, 'utf8');
      if (!/\bapplyLabels\(/.test(text)) continue;
      if (rel.startsWith(`${mainActionsDir}/`)) {
        sawMainActions = true;
      } else {
        found = true;
        fail('desktop-actions', `${rel} calls applyLabels( — only ${mainActionsDir}/ may`);
      }
    }
    if (!sawMainActions) fail('desktop-actions', `no file under ${mainActionsDir} calls applyLabels( — the guard cannot pass vacuously`);
    else if (!found) ok();
  }

  // --- shared/board/project.ts's ungated selection names approvalGate -------
  // guard(#94): the "Ungated pull requests" section rendering regardless of
  // the approval-gate module being off, instead of the section being
  // absent entirely.
  {
    const text = readFileSync(join(root, projectFile), 'utf8');
    const lines = text.split('\n');
    const ungatedLine = lines.findIndex((line) => /\bungated\s*=/.test(line));
    if (ungatedLine === -1) {
      fail('desktop-actions', `${projectFile} has no 'ungated = ...' selection to check`);
    } else {
      const window = lines.slice(Math.max(0, ungatedLine - 15), ungatedLine + 1).join('\n');
      if (!window.includes('approvalGate')) {
        fail('desktop-actions', `${projectFile}'s ungated selection does not name 'approvalGate' nearby — the module gate could be dropped silently`);
      } else {
        ok();
      }
    }
  }
}
