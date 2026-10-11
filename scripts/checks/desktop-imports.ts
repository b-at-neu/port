import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, walk, relOf } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';
import { TOP_LEVEL_AREAS } from '#desktop/scripts/alias-imports.mjs';

// The @/ alias regression guard: port/no-parent-import's own good/bad cases both ways, then the
// "Done when" assertion — no `../` import left inside src/ under preload/, shared/, renderer/ or main/.
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

  // --- No ../ import left inside src/ under preload/, shared/, renderer/ or main/ — this ticket's "Done when". ---
  {
    const dirs = ['apps/desktop/src/preload', 'apps/desktop/src/shared', 'apps/desktop/src/renderer', 'apps/desktop/src/main'];
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
    if (scanned === 0) fail('desktop-imports', 'no files scanned under preload/, shared/ or renderer/ — the guard cannot pass vacuously');
    else if (!violated) ok();
  }

  // --- No renderer-rooted @/ import left under renderer/ — every @/ specifier's first segment is a top-level src/ area. ---
  {
    const files = walk(join(root, 'apps/desktop/src/renderer')).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.mts'));
    let violated = false;
    let scanned = 0;
    for (const f of files) {
      scanned++;
      const rel = relOf(f);
      const text = readFileSync(f, 'utf8');
      const specifiers = [...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g), ...text.matchAll(/\bimport\s+['"]([^'"]+)['"]/g), ...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g), ...text.matchAll(/\b(?:vi\.mock|vi\.importActual)\(\s*['"]([^'"]+)['"]/g)].map(
        (m) => m[1],
      );
      for (const spec of specifiers) {
        if (!spec.startsWith('@/')) continue;
        const firstSegment = spec.slice(2).split('/')[0];
        if (!TOP_LEVEL_AREAS.has(firstSegment)) {
          violated = true;
          fail('desktop-imports', `${rel} imports '${spec}' — renderer-rooted @/ is gone; use @/renderer/…`);
        }
      }
    }
    if (scanned === 0) fail('desktop-imports', 'no files scanned under renderer/ — the guard cannot pass vacuously');
    else if (!violated) ok();
  }

  note(`desktop-imports: scanned preload/, shared/, renderer/ and main/ for relative parent imports and renderer-rooted @/ imports`);
}
