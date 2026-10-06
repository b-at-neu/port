import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// --- No GraphQL search(, no gh --jq under main/github/: `search` is index-backed with
// ingestion lag, and `gh` silently skips `--jq` on the partial-error response this adapter must read. ---
export default async function ({ expect, fail, ok }: Reporter) {
  const dir = 'apps/desktop/src/main/github';
  const files = walk(join(root, dir)).filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts'));

  if (files.length === 0) {
    fail('desktop-github-adapter', `${dir} has no source files — the guard cannot pass vacuously if the directory is deleted`);
    return;
  }

  // --- No file under main/github/ ever calls GraphQL search( ------------------
  {
    let found = false;
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (text.includes('search(')) {
        found = true;
        fail('desktop-github-adapter', `${relOf(f)} calls 'search(' — GraphQL search is index-backed with ingestion lag, never used here (Decision 2)`);
      }
    }
    if (!found) ok();
  }

  // --- No file under main/github/ ever passes --jq to gh ----------------------
  {
    let found = false;
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (text.includes('--jq')) {
        found = true;
        fail('desktop-github-adapter', `${relOf(f)} passes '--jq' — gh silently skips the filter on a partial-error response this adapter must read (Decision 3)`);
      }
    }
    if (!found) ok();
  }

  // pin: `main/github/query.ts`'s `CheckRollupFields` fragment selection ↔ `scripts/port-tick/query.ts`'s own `ROLLUP`, both directions
  {
    const queryFile = `${dir}/query.ts`;
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
}
