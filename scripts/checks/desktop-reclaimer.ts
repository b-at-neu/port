import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { root, walk, relOf, readJson } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';

// apps/desktop/src/main/reclaimer/ ports bin/worktrees.mjs's classification in-process, pinned
// against it by a shared case table, and spawns nothing.
export default async function ({ fail, ok }: Reporter) {
  const dir = 'apps/desktop/src/main/reclaimer';
  const files = walk(join(root, dir)).filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts'));

  // --- (1) The directory has source files at all, so this cannot pass vacuously once deleted. ---
  if (files.length === 0) {
    fail('desktop-reclaimer', `${dir} has no source files — the guard cannot pass vacuously if the directory is deleted`);
    return;
  }
  ok();

  // --- (2) Worktree enumeration stays in main/local/, and only remove.ts removes, unlocks or prunes. ---
  {
    let violated = false;
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (/worktree list --porcelain|'list'/.test(text)) {
        violated = true;
        fail('desktop-reclaimer', `${relOf(f)} enumerates worktrees itself — the list comes from main/local/'s readWorktrees, never a second caller`);
      }
      if (!f.endsWith('/remove.ts') && /worktree (remove|prune)|'worktree'/.test(text)) {
        violated = true;
        fail('desktop-reclaimer', `${relOf(f)} calls git worktree directly — only remove.ts removes, unlocks or prunes`);
      }
    }
    if (!violated) ok();
  }

  // --- (3) The subprocess path stays gone. ---
  {
    let violated = false;
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (/@\/main\/platform\/node|worktrees\.mjs/.test(text)) {
        violated = true;
        fail('desktop-reclaimer', `${relOf(f)} reaches for the node runner or names worktrees.mjs — the reclaimer is in-process and spawns nothing`);
      }
    }
    if (!violated) ok();
  }

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
