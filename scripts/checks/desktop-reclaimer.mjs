import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, walk, relOf } from '../lib/files.mjs';

// #86: apps/desktop/src/main/reclaimer/ drives the shipped
// plugins/port/templates/worktrees.mjs through commands.worktrees and never
// re-implements its classification — this directory calls no `git worktree`
// itself (main/local/'s join is the one place that does). Four assertions
// pin that mechanically, in the shape of desktop-local.mjs's own guards.
export default async function ({ fail, ok }) {
  const dir = 'apps/desktop/src/main/reclaimer';
  const files = walk(join(root, dir)).filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts'));

  // --- (1) The directory has source files at all ------------------------------
  if (files.length === 0) {
    fail('desktop-reclaimer', `${dir} has no source files — the guard cannot pass vacuously if the directory is deleted`);
    return;
  }
  ok();

  // --- (2) No file here re-implements worktree enumeration/removal -----------
  {
    let violated = false;
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (/worktree list|--porcelain|worktree remove/.test(text)) {
        violated = true;
        fail(
          'desktop-reclaimer',
          `${relOf(f)} references worktree enumeration/removal directly — the classification comes from the shipped script, and the enumeration for the join comes from main/local/, never a third caller`,
        );
      }
    }
    if (!violated) ok();
  }

  // --- (3) WORKTREE_STATES/RECLAIMABLE_STATES pinned against the template ----
  {
    const typesPath = join(root, 'apps/desktop/src/shared/reclaimer/types.ts');
    const typesText = readFileSync(typesPath, 'utf8');

    const statesMatch = /WORKTREE_STATES\s*=\s*\[([^\]]*)\]\s*as const/.exec(typesText);
    const reclaimableMatch = /RECLAIMABLE_STATES\s*=\s*\[([^\]]*)\]\s*as const/.exec(typesText);
    if (!statesMatch || !reclaimableMatch) {
      fail('desktop-reclaimer', `${relOf(typesPath)} has no 'WORKTREE_STATES = [...] as const' or 'RECLAIMABLE_STATES = [...] as const' array`);
    } else {
      const appStates = [...statesMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
      const appReclaimable = [...reclaimableMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

      const templatePath = join(root, 'plugins/port/templates/worktrees.mjs');
      const templateText = readFileSync(templatePath, 'utf8');
      const reasonFnMatch = /function describeReason\(c\) \{([\s\S]*?)\n\}/.exec(templateText);
      if (!reasonFnMatch) {
        fail('desktop-reclaimer', `${relOf(templatePath)} has no 'function describeReason(c) {...}' to read case labels from`);
      } else {
        const templateStates = [...reasonFnMatch[1].matchAll(/case '([^']+)'/g)].map((m) => m[1]);
        const templateSet = new Set(templateStates);
        const appSet = new Set(appStates);
        for (const state of appStates) {
          if (!templateSet.has(state)) {
            fail('desktop-reclaimer', `WORKTREE_STATES has '${state}', which templates/worktrees.mjs's describeReason has no case for`);
          }
        }
        for (const state of templateStates) {
          if (!appSet.has(state)) {
            fail('desktop-reclaimer', `templates/worktrees.mjs's describeReason has a case for '${state}', missing from WORKTREE_STATES`);
          }
        }
      }

      const { classifyCandidate } = await import(pathToFileURL(templatePath).href);
      const removableStates = new Set();
      for (const itemState of ['OPEN', 'CLOSED', 'MERGED', null]) {
        for (const isAncestor of [true, false, null]) {
          const result = classifyCandidate({ isOutside: false, isProtected: false, locked: false, dirty: false, itemState, isAncestor });
          if (result.removable) removableStates.add(result.state);
        }
      }
      const reclaimableSet = new Set(appReclaimable);
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

  // --- (4) Both script literals reach the app's own constants -----------------
  {
    const templatePath = join(root, 'plugins/port/templates/worktrees.mjs');
    const templateText = readFileSync(templatePath, 'utf8');
    const reportPath = join(root, 'apps/desktop/src/main/reclaimer/report.ts');
    const reportText = readFileSync(reportPath, 'utf8');

    if (!templateText.includes('FAIL  ')) {
      fail('desktop-reclaimer', `${relOf(templatePath)} no longer carries the 'FAIL  ' prefix die() emits`);
    }
    if (!templateText.includes('gh issueOrPullRequest resolution failed')) {
      fail('desktop-reclaimer', `${relOf(templatePath)} no longer carries the 'gh issueOrPullRequest resolution failed' sentence`);
    }
    if (!reportText.includes('FAIL  ')) {
      fail('desktop-reclaimer', `${relOf(reportPath)} no longer carries a pinned copy of the script's 'FAIL  ' prefix`);
    }
    if (!reportText.includes('gh issueOrPullRequest resolution failed')) {
      fail('desktop-reclaimer', `${relOf(reportPath)} no longer carries a pinned copy of the 'gh issueOrPullRequest resolution failed' sentence`);
    }
    ok();
  }
}
