import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '../lib/files.mjs';

// Issue 87: apps/desktop/src/main/search/ answers a query against every
// transcript main/sessions/ can already parse. Three assertions pin its
// plan's decisions mechanically, dependency-free and regex-based, in the
// shape of desktop-sessions.mjs's and desktop-claim.mjs's own guards —
// reading directories by explicit path (never walk('apps/'), which descends
// into node_modules).
export default async function ({ fail, ok }) {
  const searchDir = 'apps/desktop/src/main/search';
  const sharedSearchTypesFile = 'apps/desktop/src/shared/search/types.ts';
  const rendererSearchFile = 'apps/desktop/src/renderer/src/search.ts';
  const srcDir = join(root, 'apps/desktop/src');
  const allFiles = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));

  const searchFiles = allFiles.filter((f) => relOf(f).startsWith(`${searchDir}/`) && !relOf(f).endsWith('.test.ts'));

  if (searchFiles.length === 0) {
    fail('desktop-search', `${searchDir} has no source files — the guard cannot pass vacuously if the directory is deleted`);
    return;
  }

  // --- main/search/ imports the sessions barrel only, never a deep path ----
  // guard(#87): a second transcript parser or a second Agent SDK seam,
  // growing back the exact drift `main/sessions/` exists to prevent
  // (ENGINEERING §1) -- `../sessions` (the barrel) is fine; `../sessions/*`
  // is not.
  {
    let found = false;
    const deepImport = /from\s+['"]\.\.\/sessions\/[^'"]+['"]/;
    for (const f of searchFiles) {
      const rel = relOf(f);
      const text = readFileSync(f, 'utf8');
      if (deepImport.test(text)) {
        found = true;
        fail('desktop-search', `${rel} imports a deep '../sessions/*' path — main/search/ may only import the barrel ('../sessions')`);
      }
      if (text.includes('@anthropic-ai/claude-agent-sdk')) {
        found = true;
        fail('desktop-search', `${rel} references '@anthropic-ai/claude-agent-sdk' -- only apps/desktop/src/main/sessions/sdk.ts may (Decision 3, #78)`);
      }
    }
    if (!found) ok();
  }

  // --- shared/search/types.ts declares every honesty field; the renderer ---
  // --- reads 'complete' before rendering an empty result ---
  // guard(#87): a partial (budget-bounded) search rendering as an exhaustive
  // "no matches" -- the plan's own "direction of failure: closed on the
  // answer, open on reporting" contract for SearchResult.
  {
    const typesFile = allFiles.find((f) => relOf(f) === sharedSearchTypesFile);
    const rendererFile = allFiles.find((f) => relOf(f) === rendererSearchFile);
    if (!typesFile) {
      fail('desktop-search', `${sharedSearchTypesFile} does not exist`);
    } else if (!rendererFile) {
      fail('desktop-search', `${rendererSearchFile} does not exist`);
    } else {
      const typesText = readFileSync(typesFile, 'utf8');
      const rendererText = readFileSync(rendererFile, 'utf8');
      const requiredFields = ['inScope', 'read', 'unreached', 'complete'];
      const missing = requiredFields.filter((field) => !new RegExp(`\\b${field}\\s*:`).test(typesText));
      if (missing.length > 0) {
        fail('desktop-search', `${sharedSearchTypesFile}'s SearchResult is missing field(s): ${missing.join(', ')}`);
      } else if (!/\bcomplete\b/.test(rendererText)) {
        fail('desktop-search', `${rendererSearchFile} never references 'complete' -- a partial search must never render as an exhaustive empty result`);
      } else {
        ok();
      }
    }
  }

  // --- MIN_TERM_CHARS === TRIGRAM_SIZE ---
  // guard(#87): a term shorter than the trigram filter's own n-gram makes
  // the index skip silently lossy -- a term with fewer characters than a
  // trigram has no windows to test, so `mightContain` trivially reads
  // "present" for a term the signature was never actually built to answer.
  {
    const typesFile = allFiles.find((f) => relOf(f) === sharedSearchTypesFile);
    if (!typesFile) {
      fail('desktop-search', `${sharedSearchTypesFile} does not exist`);
    } else {
      const text = readFileSync(typesFile, 'utf8');
      const minTermMatch = /MIN_TERM_CHARS\s*=\s*(\d+)/.exec(text);
      const trigramMatch = /TRIGRAM_SIZE\s*=\s*(\d+)/.exec(text);
      if (!minTermMatch || !trigramMatch) {
        fail('desktop-search', `${sharedSearchTypesFile} must declare both 'MIN_TERM_CHARS' and 'TRIGRAM_SIZE' as numeric literals`);
      } else if (minTermMatch[1] !== trigramMatch[1]) {
        fail('desktop-search', `MIN_TERM_CHARS (${minTermMatch[1]}) must equal TRIGRAM_SIZE (${trigramMatch[1]})`);
      } else {
        ok();
      }
    }
  }
}
