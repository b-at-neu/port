import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, readJson, walk, relOf } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';

/** Every import-like specifier in `text`, static and side-effect forms anchored at line start so a string embedded in an error message never counts, plus dynamic `import('…')` and `vi.mock`/`vi.importActual`. */
function specifiersOf(text: string): string[] {
  return [
    ...text.matchAll(/^import\s+(?:type\s+)?[\s\S]*?\bfrom\s+['"]([^'"]+)['"]/gm),
    ...text.matchAll(/^import\s+['"]([^'"]+)['"]/gm),
    ...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g),
    ...text.matchAll(/\b(?:vi\.mock|vi\.importActual)\(\s*['"]([^'"]+)['"]/g),
  ].map((m) => m[1]);
}

// This ticket's "Done when": no `../` import left in scripts/, every `#` specifier resolves against the root package.json's imports map, and the desktop bundle never resolves a `#` alias through a port-tick module it imports.
export default async function ({ expect, fail, note, ok }: Reporter) {
  const files = walk(join(root, 'scripts')).filter((f) => f.endsWith('.ts'));
  if (files.length === 0) {
    fail('scripts-imports', 'no files scanned under scripts/ — the guard cannot pass vacuously');
    return;
  }

  const pkg = readJson('package.json');
  const importKeys: string[] = Object.keys(pkg.imports ?? {});

  // --- No ../ import left anywhere under scripts/. ---
  {
    let violated = false;
    for (const f of files) {
      const rel = relOf(f);
      const text = readFileSync(f, 'utf8');
      for (const spec of specifiersOf(text)) {
        if (spec.startsWith('../')) {
          violated = true;
          fail('scripts-imports', `${rel} still imports '${spec}' with a relative parent path — use a '#' specifier`);
        }
      }
    }
    if (!violated) ok();
  }

  // --- No ./lib/ specifier outside scripts/lib/ itself. ---
  {
    let violated = false;
    for (const f of files) {
      const rel = relOf(f);
      if (rel.startsWith('scripts/lib/')) continue;
      const text = readFileSync(f, 'utf8');
      for (const spec of specifiersOf(text)) {
        if (spec.startsWith('./lib/')) {
          violated = true;
          fail('scripts-imports', `${rel} imports '${spec}' — lib/ is a separate root outside scripts/lib/, use '#lib/…'`);
        }
      }
    }
    if (!violated) ok();
  }

  // --- Every #x/ specifier's #x/* key exists in the root package.json's imports map. ---
  {
    let violated = false;
    for (const f of files) {
      const rel = relOf(f);
      const text = readFileSync(f, 'utf8');
      for (const spec of specifiersOf(text)) {
        if (!spec.startsWith('#')) continue;
        const firstSegment = spec.split('/')[0];
        const key = `${firstSegment}/*`;
        if (!importKeys.includes(key)) {
          violated = true;
          fail('scripts-imports', `${rel} imports '${spec}' — no '${key}' entry in the root package.json's imports map`);
        }
      }
    }
    if (!violated) ok();
  }

  // --- No # specifier in a scripts/port-tick/*.ts file that apps/desktop/src imports — keeps the desktop bundle free of root # aliases. ---
  {
    const desktopSrc = join(root, 'apps/desktop/src');
    const desktopFiles = walk(desktopSrc).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.mts'));
    const importedPortTickFiles = new Set<string>();
    for (const f of desktopFiles) {
      const text = readFileSync(f, 'utf8');
      for (const spec of specifiersOf(text)) {
        const m = /scripts\/port-tick\/([^'"]+)/.exec(spec);
        if (m) importedPortTickFiles.add(m[1].replace(/\.ts$/, ''));
      }
    }

    let violated = false;
    const portTickFiles = walk(join(root, 'scripts/port-tick')).filter((f) => f.endsWith('.ts'));
    for (const f of portTickFiles) {
      const rel = relOf(f);
      const base = rel.replace(/^scripts\/port-tick\//, '').replace(/\.ts$/, '');
      if (!importedPortTickFiles.has(base)) continue;
      const text = readFileSync(f, 'utf8');
      for (const spec of specifiersOf(text)) {
        if (spec.startsWith('#')) {
          violated = true;
          fail('scripts-imports', `${rel} imports '${spec}' — apps/desktop/src imports this module, so it must stay free of root '#' aliases`);
        }
      }
    }
    expect(importedPortTickFiles.size > 0, 'scripts-imports', 'no apps/desktop/src import of scripts/port-tick/* found — the guard cannot pass vacuously');
    if (!violated) ok();
  }

  note(`scripts-imports: scanned ${files.length} scripts/ files for '../' imports, stray './lib/' specifiers, unmapped '#' specifiers, and desktop-imported port-tick modules using '#'`);
}
