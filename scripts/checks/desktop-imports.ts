import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// The @/ alias regression guard: port/no-parent-import's own good/bad cases both ways, then the
// "Done when" assertion — no `../` import left inside src/ under preload/ or shared/.
export default async function ({ expect, fail, note, ok }: Reporter) {
  const ruleUrl = pathToFileURL(join(root, 'apps/desktop/eslint/no-parent-import.mjs')).href;
  const mod = await import(ruleUrl);

  // --- Every no-parent-import CASES entry agrees with isParentImport, both ways. ---
  {
    const cases = mod.CASES as { file: string; spec: string; flagged: boolean }[];
    if (!cases || cases.length === 0) {
      fail('desktop-imports', 'no-parent-import.mjs exports no CASES — the guard cannot pass vacuously if they are all removed');
    } else {
      for (const c of cases) {
        const got = mod.isParentImport(c.file, c.spec) as boolean;
        expect(got === c.flagged, 'desktop-imports', `isParentImport(${c.file}, ${c.spec}) returned ${String(got)}, expected ${String(c.flagged)}`);
      }
      ok();
    }
  }

  // --- No ../ import left inside src/ under preload/ or shared/ — this ticket's "Done when". ---
  {
    const dirs = ['apps/desktop/src/preload', 'apps/desktop/src/shared'];
    let violated = false;
    let scanned = 0;
    for (const dir of dirs) {
      const files = walk(join(root, dir)).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.mts'));
      for (const f of files) {
        scanned++;
        const rel = relOf(f);
        const text = readFileSync(f, 'utf8');
        const specifiers = [...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g), ...text.matchAll(/\bimport\s+['"]([^'"]+)['"]/g), ...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g), ...text.matchAll(/\b(?:vi\.mock|vi\.importActual)\(\s*['"]([^'"]+)['"]/g)].map(
          (m) => m[1],
        );
        for (const spec of specifiers) {
          if (mod.isParentImport(f, spec)) {
            violated = true;
            fail('desktop-imports', `${rel} still imports '${spec}' with a relative parent path that stays inside src/ — use the @/ alias`);
          }
        }
      }
    }
    if (scanned === 0) fail('desktop-imports', 'no files scanned under preload/ or shared/ — the guard cannot pass vacuously');
    else if (!violated) ok();
  }

  note(`desktop-imports: scanned preload/ and shared/ for relative parent imports`);
}
