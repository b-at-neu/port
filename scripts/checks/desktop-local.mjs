import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson, walk, relOf } from '../lib/files.mjs';

// #77: apps/desktop/src/main/local/ is the app's only reader of the two local
// sources the pipeline writes (`git worktree list --porcelain` and
// `.agents/denials.log`). Four assertions pin its decisions mechanically, in
// the shape of desktop-github.mjs's/desktop-registry.mjs's own guards.
export default async function ({ fail, ok }) {
  const dir = 'apps/desktop/src/main/local';
  const files = walk(join(root, dir)).filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts'));

  // --- (1) The directory has source files at all ------------------------------
  if (files.length === 0) {
    fail('desktop-local-adapter', `${dir} has no source files — the guard cannot pass vacuously if the directory is deleted`);
    return;
  }
  ok();

  // --- (2) Decision 1: no gh( / ghJson( / main/github, and at least one imports `git` ---
  {
    let usesGit = false;
    let violated = false;
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      // Strip comment-only lines first — this file's own header prose (and
      // `worktrees.ts`'s doc comments) name `main/github/adapter.ts` as a
      // precedent to follow, which must not itself trip the guard.
      const codeOnly = text
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      if (/\bgh\s*\(|\bghJson\s*\(|main\/github/.test(codeOnly)) {
        violated = true;
        fail('desktop-local-adapter', `${relOf(f)} references gh(/ghJson(/main/github — this directory is local-only (Decision 1), never a second GitHub caller`);
      }
      if (/import\s*\{[^}]*\bgit\b[^}]*\}\s*from\s*'\.\.\/platform'/.test(codeOnly)) {
        usesGit = true;
      }
    }
    if (!usesGit) {
      fail('desktop-local-adapter', `no file under ${dir} imports 'git' from the platform layer — the guard cannot pass vacuously if the git call is removed`);
    } else if (!violated) {
      ok();
    }
  }

  // --- (3) Decision 4: never hard-code .claude/worktrees ----------------------
  {
    let found = false;
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (text.includes('.claude/worktrees')) {
        found = true;
        fail('desktop-local-adapter', `${relOf(f)} contains the literal '.claude/worktrees' — the worktree producer must derive from the basename, never a hard-coded path (Decision 4)`);
      }
    }
    if (!found) ok();
  }

  // --- (4) The shared case table pins both correlate ladders together --------
  {
    const casesPath = join(root, dir, 'correlation.cases.json');
    const cases = readJson(`${dir}/correlation.cases.json`);

    const rungs = new Set(cases.map((c) => c.expect?.rung).filter(Boolean));
    for (const rung of ['upstream-branch', 'branch-name', 'directory-basename', 'head-subject']) {
      if (!rungs.has(rung)) {
        fail('desktop-local-correlation-table', `${relOf(casesPath)} has no case whose expect.rung is '${rung}' — the table must cover all four rungs`);
      }
    }
    if (!cases.some((c) => c.name.includes('#0'))) {
      fail('desktop-local-correlation-table', `${relOf(casesPath)} has no '#0' case`);
    }
    if (!cases.some((c) => c.expect === null)) {
      fail('desktop-local-correlation-table', `${relOf(casesPath)} has no case expecting null (a fully unresolvable entry)`);
    }
    ok();

    const { correlate } = await import(pathToFileURL(join(root, 'plugins/port/templates/worktrees.mjs')).href);
    for (const c of cases) {
      const actual = correlate(c.input);
      const expected = c.expect;
      const matches = expected === null ? actual === null : actual !== null && actual.number === expected.number && actual.rung === expected.rung;
      if (!matches) {
        fail(
          'desktop-local-correlation-table',
          `templates/worktrees.mjs's correlate() disagrees with '${c.name}': expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        );
      }
    }
    ok();
  }
}
