import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// apps/desktop/src/main/search/ answers a query against every transcript main/sessions/ can
// already parse. These assertions pin its plan's decisions mechanically.
export default async function ({ expect, fail, ok }: Reporter) {
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

  // --- main/search/ imports only the named sessions files it needs — never a second
  // transcript parser or a second Agent SDK seam, the exact drift main/sessions/ prevents. ---
  {
    let found = false;
    const allowedDeepImports = new Set(['../sessions/locate', '../sessions/transcript']);
    const deepImport = /from\s+['"](\.\.\/sessions\/[^'"]+)['"]/g;
    for (const f of searchFiles) {
      const rel = relOf(f);
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(deepImport)) {
        if (!allowedDeepImports.has(m[1])) {
          found = true;
          fail('desktop-search', `${rel} imports '${m[1]}' — main/search/ may only import '../sessions/locate' or '../sessions/transcript'`);
        }
      }
      if (text.includes('@anthropic-ai/claude-agent-sdk')) {
        found = true;
        fail('desktop-search', `${rel} references '@anthropic-ai/claude-agent-sdk' -- only apps/desktop/src/main/sessions/sdk.ts may (Decision 3, #78)`);
      }
    }
    if (!found) ok();
  }

  // --- shared/search/types.ts declares every honesty field; the renderer reads 'complete'
  // before rendering an empty result — a partial search must never render as exhaustive. ---
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
      } else expect(/\bcomplete\b/.test(rendererText), 'desktop-search', `${rendererSearchFile} never references 'complete' -- a partial search must never render as an exhaustive empty result`);
    }
  }

  // --- MIN_TERM_CHARS === TRIGRAM_SIZE — a shorter term has no windows to test, so
  // `mightContain` trivially reads "present" for a term the signature was never built to answer. ---
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
      } else expect(!(minTermMatch[1] !== trigramMatch[1]), 'desktop-search', `MIN_TERM_CHARS (${minTermMatch[1]}) must equal TRIGRAM_SIZE (${trigramMatch[1]})`);
    }
  }
}
