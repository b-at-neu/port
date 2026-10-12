import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, walk, relOf } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';
import { TOP_LEVEL_AREAS } from '#desktop/scripts/alias-imports.mjs';

// The @/ alias regression guard: port/no-parent-import's own good/bad cases both ways, then the
// "Done when" assertion — no `../` import left anywhere inside src/.
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

  // --- No ../ import left anywhere inside src/ — this ticket's "Done when". ---
  {
    const files = walk(join(root, 'apps/desktop/src')).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.mts'));
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
        if (mod.isParentImport(f, spec)) {
          violated = true;
          fail('desktop-imports', `${rel} still imports '${spec}' with a relative parent path that stays inside src/ — use the @/ alias`);
        }
      }
    }
    if (scanned === 0) fail('desktop-imports', 'no files scanned under apps/desktop/src — the guard cannot pass vacuously');
    else if (!violated) ok();
  }

  // --- No ../ import left inside tests/unit/ or tests/fixtures/ that climbs into src/ — a moved
  // unit test must import its source with @/. ---
  {
    const dirs = ['apps/desktop/tests/unit', 'apps/desktop/tests/fixtures'];
    const files = dirs.flatMap((dir) => walk(join(root, dir))).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
    let violated = false;
    for (const f of files) {
      const rel = relOf(f);
      const text = readFileSync(f, 'utf8');
      const specifiers = [...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g), ...text.matchAll(/\bimport\s+['"]([^'"]+)['"]/g), ...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g), ...text.matchAll(/\b(?:vi\.mock|vi\.importActual)\(\s*['"]([^'"]+)['"]/g)].map(
        (m) => m[1],
      );
      for (const spec of specifiers) {
        if (mod.isParentImport(f, spec)) {
          violated = true;
          fail('desktop-imports', `${rel} still imports '${spec}' with a relative parent path that climbs into src/ — use the @/ alias`);
        }
        if (spec.startsWith('@/')) {
          const firstSegment = spec.slice(2).split('/')[0];
          if (!TOP_LEVEL_AREAS.has(firstSegment)) {
            violated = true;
            fail('desktop-imports', `${rel} imports '${spec}' — '${firstSegment}' is not a top-level src/ area`);
          }
        }
      }
    }
    if (files.length === 0) fail('desktop-imports', 'no files scanned under apps/desktop/tests/unit/ or tests/fixtures/ — the guard cannot pass vacuously');
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

  // --- apps/desktop/src/shared does not exist — the whole split is complete. ---
  expect(!existsSync(join(root, 'apps/desktop/src/shared')), 'desktop-imports', 'apps/desktop/src/shared still exists — every file must move to types/, utils/, renderer/ or main/');

  // --- Every non-test file under utils/ is imported by both main/ and renderer/, directly or
  // through another utils/ module — a utils/ module only one side ever reaches belongs to that side instead. ---
  {
    const specifierPattern = /\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]|\b(?:vi\.mock|vi\.importActual)\(\s*['"]([^'"]+)['"]/g;
    const specifiersOf = (text: string): string[] => [...text.matchAll(specifierPattern)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]).filter((s): s is string => s !== undefined);

    const allSrcFiles = walk(join(root, 'apps/desktop/src')).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.mts'));
    const utilsFiles = allSrcFiles.filter((f) => relOf(f).startsWith('apps/desktop/src/utils/') && !relOf(f).endsWith('.test.ts'));

    if (utilsFiles.length === 0) {
      fail('desktop-imports', 'no non-test files under apps/desktop/src/utils/ — the guard cannot pass vacuously if the directory is emptied');
    } else {
      const utilsModuleOf = (rel: string): string => `@/${rel.slice('apps/desktop/src/'.length).replace(/\.tsx?$/, '')}`;
      const utilsModules = new Set(utilsFiles.map((f) => utilsModuleOf(relOf(f))));

      // Edges from one utils/ module to another, plus the set of utils/ modules a main/ or renderer/ file imports directly.
      const utilsGraph = new Map<string, Set<string>>();
      const mainEntryUtils = new Set<string>();
      const rendererEntryUtils = new Set<string>();
      for (const f of allSrcFiles) {
        const rel = relOf(f);
        if (rel.endsWith('.test.ts')) continue;
        const specs = specifiersOf(readFileSync(f, 'utf8')).filter((s) => utilsModules.has(s));
        if (rel.startsWith('apps/desktop/src/utils/')) {
          utilsGraph.set(utilsModuleOf(rel), new Set(specs));
        } else if (rel.startsWith('apps/desktop/src/main/')) {
          for (const s of specs) mainEntryUtils.add(s);
        } else if (rel.startsWith('apps/desktop/src/renderer/')) {
          for (const s of specs) rendererEntryUtils.add(s);
        }
      }

      const reachableFrom = (entries: Set<string>): Set<string> => {
        const seen = new Set<string>();
        const queue = [...entries];
        while (queue.length > 0) {
          const m = queue.pop()!;
          if (seen.has(m)) continue;
          seen.add(m);
          for (const next of utilsGraph.get(m) ?? []) queue.push(next);
        }
        return seen;
      };

      const reachableFromMain = reachableFrom(mainEntryUtils);
      const reachableFromRenderer = reachableFrom(rendererEntryUtils);

      let violated = false;
      for (const m of utilsModules) {
        const mainOk = reachableFromMain.has(m);
        const rendererOk = reachableFromRenderer.has(m);
        if (!mainOk || !rendererOk) {
          violated = true;
          const missing = !mainOk && !rendererOk ? 'main/ and renderer/' : !mainOk ? 'main/' : 'renderer/';
          fail('desktop-imports', `${m} is never imported from ${missing} (directly or through another utils/ module) — a utils/ module only one side reaches belongs to that side instead`);
        }
      }
      if (!violated) ok();
    }
  }

  // --- Fixture first — findLeakedTypes can't pass vacuously on a good fixture or three bad ones. ---
  const typeMoves = await import(pathToFileURL(join(root, 'apps/desktop/scripts/type-moves.mjs')).href);
  {
    const good = typeMoves.findLeakedTypes([
      { path: 'renderer/a.ts', text: "export interface Solo {\n  readonly x: number\n}\n" },
    ]);
    if (good.length !== 0) fail('desktop-imports', `fixture 'good' expected no leaked types, got ${String(good.length)}`);
    else ok();

    const badSibling = typeMoves.findLeakedTypes([
      { path: 'renderer/a.ts', text: "export interface Leaked {\n  readonly x: number\n}\n" },
      { path: 'renderer/b.ts', text: "import type { Leaked } from './a'\n" },
    ]);
    if (badSibling.length !== 1) fail('desktop-imports', `fixture 'renderer sibling' expected 1 leaked type, got ${String(badSibling.length)}`);
    else ok();

    const badTestImporter = typeMoves.findLeakedTypes([
      { path: 'main/a.ts', text: "export interface Leaked {\n  readonly x: number\n}\n" },
      { path: 'a.test.ts', text: "import type { Leaked } from '@/main/a'\n" },
    ]);
    if (badTestImporter.length !== 1) fail('desktop-imports', `fixture 'main test importer' expected 1 leaked type, got ${String(badTestImporter.length)}`);
    else ok();

    const badTsxImporter = typeMoves.findLeakedTypes([
      { path: 'renderer/a.ts', text: "export interface Leaked {\n  readonly x: number\n}\n" },
      { path: 'renderer/b.tsx', text: "import { type Leaked } from './a'\n" },
    ]);
    if (badTsxImporter.length !== 1) fail('desktop-imports', `fixture '.tsx importer' expected 1 leaked type, got ${String(badTsxImporter.length)}`);
    else ok();
  }

  // --- No MULTI-classified type under main/ or renderer/ (non-test) is still exported. ---
  {
    const { declByKey, mainFiles } = typeMoves.classify() as { declByKey: Map<string, { file: string; name: string }>; mainFiles: string[] };
    if (mainFiles.length === 0) {
      fail('desktop-imports', 'no non-test files scanned under apps/desktop/src/main or src/renderer — the guard cannot pass vacuously');
    } else {
      let violated = false;
      for (const decl of declByKey.values()) {
        if (typeMoves.classOf(decl, decl.file) !== 'MULTI') continue;
        violated = true;
        fail('desktop-imports', `${relOf(decl.file)} still exports '${decl.name}', used by more than one other file — move it to types/<topic> (apps/desktop/scripts/type-moves.mjs)`);
      }
      if (!violated) ok();
    }
  }

  note(`desktop-imports: scanned apps/desktop/src, tests/unit/ and tests/fixtures/ for relative parent imports, renderer-rooted @/ imports, the absence of shared/, utils/ reach from both sides, and no main/ or renderer/ exported type imported elsewhere`);
}
