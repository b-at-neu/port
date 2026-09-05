import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '../lib/files.mjs';

// #76: apps/desktop/src/main/github/ is the app's only GitHub reader. Two
// decisions from its plan are pinned mechanically, dependency-free and
// regex-based, in the shape of desktop-platform.mjs's own guards — reading
// this directory by explicit path (never walk('apps/'), which descends into
// node_modules).
//
// - Decision 2: GraphQL `search` is rejected — it is index-backed with
//   ingestion lag, so a label applied seconds ago would not be searchable
//   yet. `repository.issues`/`pullRequests` are read-your-writes consistent.
// - Decision 3: the envelope is parsed, never `--jq`'d — `gh api graphql`
//   silently skips the `--jq` filter on the exact partial-error response
//   this adapter most needs to read.
export default async function ({ fail, ok }) {
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
}
