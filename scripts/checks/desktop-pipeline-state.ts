import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';

// The app-owned pipeline state store: a transition can neither bypass it nor reach the file
// around it. Regex-based, dependency-free, reading directories by explicit path.
export default async function ({ expect, fail, ok }: Reporter) {
  const mainDir = 'apps/desktop/src/main';
  const stateDir = `${mainDir}/pipeline-state`;
  const sources = walk(join(root, 'apps/desktop/src')).filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts'));
  const read = (f: string) => readFileSync(f, 'utf8');

  // --- Vacuity guard: the store directory has its four modules. ---
  const stateFiles = sources.filter((f) => relOf(f).startsWith(`${stateDir}/`)).map((f) => relOf(f));
  for (const name of ['model', 'store', 'writer', 'default']) {
    expect(stateFiles.includes(`${stateDir}/${name}.ts`), 'desktop-pipeline-state', `${stateDir}/${name}.ts is missing — the store's modules cannot pass vacuously`);
  }

  // --- applyLabels is imported only by the composition that hands it to the writer; desktop-actions pins the one call site. ---
  {
    let found = false;
    for (const f of sources) {
      const rel = relOf(f);
      if (!rel.startsWith(`${mainDir}/`) || rel.startsWith(`${mainDir}/writes/`)) continue;
      if (/import\s*\{[^}]*\bapplyLabels\b[^}]*\}\s*from\s*'@\/main\/writes\/apply'/.test(read(f)) && rel !== `${stateDir}/default.ts`) {
        found = true;
        fail('desktop-pipeline-state', `${rel} imports applyLabels — only ${stateDir}/default.ts may, so no transition bypasses the store`);
      }
    }
    if (!found) ok();
  }

  // --- The store file has one writer: only the composition names it, and only store.ts writes it. ---
  {
    let found = false;
    for (const f of sources) {
      const rel = relOf(f);
      if (rel !== `${stateDir}/default.ts` && read(f).includes('pipeline-state.json')) {
        found = true;
        fail('desktop-pipeline-state', `${rel} names pipeline-state.json — only ${stateDir}/default.ts may, which hands the path to the store`);
      }
      if (rel.startsWith(`${stateDir}/`) && rel !== `${stateDir}/store.ts` && /\bwriteJsonAtomic\s*\(/.test(read(f))) {
        found = true;
        fail('desktop-pipeline-state', `${rel} writes JSON — ${stateDir}/store.ts is the only writer of the store file`);
      }
    }
    if (!found) ok();
  }

  // --- Dispatch and tick read an item's labels only through the store reader's fallback. ---
  {
    let found = false;
    for (const f of sources) {
      const rel = relOf(f);
      if (!rel.startsWith(`${mainDir}/tick/`) && !rel.startsWith(`${mainDir}/dispatch/`)) continue;
      for (const line of read(f).split('\n')) {
        if (/\b(?:resolved\w*|fresh|reread)\.labels\b/.test(line) && !line.includes('stateLabels ??')) {
          found = true;
          fail('desktop-pipeline-state', `${rel} reads a ResolvedItem's labels directly (${line.trim()}) — read them through the store's stateLabels, falling back with '??'`);
        }
      }
    }
    if (!found) ok();
  }
}
