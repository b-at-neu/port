import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// --- No GraphQL search(, no gh --jq under main/github/ ----------------------
// guard(#76): the index-backed search field's ingestion lag reintroducing
// silent staleness, or `gh` silently skipping its own `--jq` filter on a
// partial-error response this adapter must read. apps/desktop/src/main/github/
// is the app's only GitHub reader; two decisions from its plan are pinned
// mechanically, dependency-free and regex-based, in the shape of
// desktop-platform.ts's own guards — reading this directory by explicit
// path (never walk('apps/'), which descends into node_modules).
//
// - Decision 2: GraphQL `search` is rejected — it is index-backed with
//   ingestion lag, so a label applied seconds ago would not be searchable
//   yet. `repository.issues`/`pullRequests` are read-your-writes consistent.
// - Decision 3: the envelope is parsed, never `--jq`'d — `gh api graphql`
//   silently skips the `--jq` filter on the exact partial-error response
//   this adapter most needs to read.
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

  // --- pin: query.ts's CheckRollupFields selection ↔ scripts/port-tick/query.ts's own ROLLUP ---
  // guard(#292): the app's own statusCheckRollup selection silently drifting
  // from the cockpit's own ROLLUP constant it was copied from — either side
  // then reads a field (or a __typename branch) the other's reducer was
  // never written to expect.
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
      // Both sides are read as the set of GraphQL field/selection tokens
      // they name — never as byte-identical text, since the app's fragment
      // is spread onto a pull-request alias while the engine's own ROLLUP is
      // inlined under a `commits(...)` selection of its own.
      const tokenize = (text: string): Set<string> => new Set(text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
      const appTokens = tokenize(fragmentMatch[1]);
      const engineTokens = tokenize(rollupMatch[1]);
      const onlyInApp = [...appTokens].filter((t) => !engineTokens.has(t));
      const onlyInEngine = [...engineTokens].filter((t) => !appTokens.has(t));
      expect(!(onlyInApp.length > 0 || onlyInEngine.length > 0), 'desktop-github-adapter', `${queryFile}'s CheckRollupFields selection and scripts/port-tick/query.ts's ROLLUP disagree — only in the app: ${onlyInApp.join(', ') || '(none)'}; only in the engine: ${onlyInEngine.join(', ') || '(none)'}`);
    }
  }
}
