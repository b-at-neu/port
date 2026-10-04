import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// #74: the registry's config contract (defaults and validation) is read from
// schema/port.config.schema.json at runtime, never transcribed into
// TypeScript (ENGINEERING §1, decisions 1-2). Two assertions pin that, in the
// shape of desktop-platform.ts's own guards.

/** Walks only the schema sub-trees `CONFIG_DEFAULTS` (plus `tracker`, read
 *  the same way elsewhere) actually reads — `tracker`, `branches`, `models`
 *  — collecting every leaf `default` whose declared `type` is `'string'`.
 *  Deliberately excludes `labels`: those defaults are a different contract,
 *  already pinned by `labels.ts`'s own guard, and its ~18 short label
 *  names (`ready`, `blocked`, …) would otherwise collide with unrelated
 *  identifiers throughout the registry's own code. */
function collectStringDefaults(schema: any): string[] {
  const roots = [schema.properties.tracker, schema.properties.branches, schema.properties.models];
  const defaults = new Set<string>();
  function walkNode(node: any): void {
    if (typeof node !== 'object' || node === null) return;
    const type = node.type;
    const isStringType = type === 'string' || (Array.isArray(type) && type.includes('string'));
    if (isStringType && typeof node.default === 'string' && node.default.length > 0) {
      defaults.add(node.default);
    }
    if (typeof node.properties === 'object' && node.properties !== null) {
      for (const child of Object.values(node.properties)) walkNode(child);
    }
  }
  for (const node of roots) walkNode(node);
  return [...defaults];
}

export default async function ({ fail, ok }: Reporter) {
  const srcDir = join(root, 'apps/desktop/src');
  const files = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  const schemaImportPattern = /['"](?:\.\.\/)+schema\/port\.config\.schema\.json['"]/;

  // --- The shipped schema is imported by exactly one file, and it is imported ---
  // guard(#74): the registry silently re-deriving the config contract
  // instead of reading the shipped schema, or the guard passing vacuously
  // once the importer is deleted.
  {
    const importers = files.filter((f) => schemaImportPattern.test(readFileSync(f, 'utf8')));
    if (importers.length === 0) {
      fail('desktop-registry', 'no file under apps/desktop/src/ imports schema/port.config.schema.json — the guard cannot pass vacuously if this file is deleted');
    } else if (importers.length > 1) {
      fail(
        'desktop-registry',
        `schema/port.config.schema.json is imported by ${importers.length} files, expected exactly one: ${importers.map(relOf).join(', ')}`,
      );
    } else {
      ok();
    }
  }

  // --- No file under main/registry/ retypes a string default as a literal ---
  // guard(#74): a schema default retyped by hand instead of read off the
  // CONFIG_DEFAULTS import, drifting the moment the schema changes.
  {
    const schema = readJson('schema/port.config.schema.json');
    const stringDefaults = collectStringDefaults(schema);
    const registryDir = join(srcDir, 'main/registry');
    for (const f of walk(registryDir).filter((p) => (p.endsWith('.ts') || p.endsWith('.tsx')) && !p.endsWith('.test.ts'))) {
      const rel = relOf(f);
      const text = readFileSync(f, 'utf8');
      for (const value of stringDefaults) {
        if (text.includes(`'${value}'`) || text.includes(`"${value}"`)) {
          fail('desktop-registry', `${rel}: literal '${value}' must come from the schema import (CONFIG_DEFAULTS), not be retyped`);
        }
      }
    }
    ok();
  }

  // #300: main/registry/overrides.ts is a typed, verbatim port of
  // scripts/port-tick/overrides.ts — the same constants and exported
  // function names, both directions.

  const appOverridesPath = join(root, 'apps/desktop/src/main/registry/overrides.ts');
  const engineOverridesPath = join(root, 'scripts/port-tick/overrides.ts');
  const appOverridesModule = await import(pathToFileURL(appOverridesPath).href);
  const engineOverridesModule = await import(pathToFileURL(engineOverridesPath).href);

  // --- Port constants and exports agree, both directions ----------------------
  // guard(#300): the app's own port silently drifting from the engine it
  // copies — a refused category the engine added never reaching the app, or
  // the app inventing a category the engine does not recognize.
  // pin: `apps/desktop/src/main/registry/overrides.ts`'s `BEGIN`/`END`/`OVERRIDABLE`/`NEVER_OVERRIDABLE`/`[...PERMISSION_SURFACE]` ↔ `scripts/port-tick/overrides.ts`'s own, both directions
  {
    if (appOverridesModule.BEGIN !== engineOverridesModule.BEGIN || appOverridesModule.END !== engineOverridesModule.END) {
      fail('desktop-registry', "main/registry/overrides.ts's BEGIN/END markers disagree with scripts/port-tick/overrides.ts's own");
    } else {
      ok();
    }

    const arraysAgree = (a: string[], b: string[]): boolean => a.length === b.length && a.every((v) => b.includes(v)) && b.every((v) => a.includes(v));
    if (!arraysAgree(appOverridesModule.OVERRIDABLE, engineOverridesModule.OVERRIDABLE)) {
      fail('desktop-registry', "main/registry/overrides.ts's OVERRIDABLE disagrees with scripts/port-tick/overrides.ts's own");
    } else {
      ok();
    }
    if (!arraysAgree(appOverridesModule.NEVER_OVERRIDABLE, engineOverridesModule.NEVER_OVERRIDABLE)) {
      fail('desktop-registry', "main/registry/overrides.ts's NEVER_OVERRIDABLE disagrees with scripts/port-tick/overrides.ts's own");
    } else {
      ok();
    }
    if (!arraysAgree([...appOverridesModule.PERMISSION_SURFACE], [...engineOverridesModule.PERMISSION_SURFACE])) {
      fail('desktop-registry', "main/registry/overrides.ts's PERMISSION_SURFACE disagrees with scripts/port-tick/overrides.ts's own");
    } else {
      ok();
    }

    const appFunctions = new Set(Object.keys(appOverridesModule).filter((k) => typeof appOverridesModule[k] === 'function'));
    const engineFunctions = new Set(Object.keys(engineOverridesModule).filter((k) => typeof engineOverridesModule[k] === 'function'));
    const allNames = new Set([...appFunctions, ...engineFunctions]);
    const mismatches = [...allNames].filter((name) => appFunctions.has(name) !== engineFunctions.has(name));
    if (mismatches.length > 0) {
      fail('desktop-registry', `main/registry/overrides.ts's exported functions and scripts/port-tick/overrides.ts's disagree on: ${mismatches.join(', ')}`);
    } else {
      ok();
    }
  }

  // --- Case-table pin: overrides.test.ts names a real case table --------------
  // guard(#300): a test silently drifting off the shared table it exists to
  // be asserted against, so the two implementations could disagree with
  // nothing to catch it.
  // pin: `scripts/port-tick/cases/overrides.cases.json` ↔ `apps/desktop/src/main/registry/overrides.ts`'s ported `parseOverrides`/`applyOverrides`, the same table `tick-cases` already asserts the engine's own exports against
  {
    const testPath = join(root, 'apps/desktop/src/main/registry/overrides.test.ts');
    const tablePath = join(root, 'scripts/port-tick/cases/overrides.cases.json');
    const testText = readFileSync(testPath, 'utf8');
    if (!testText.includes('overrides.cases.json')) {
      fail('desktop-registry', `${relOf(testPath)} does not import overrides.cases.json at all`);
    } else {
      try {
        readFileSync(tablePath, 'utf8');
        ok();
      } catch {
        fail('desktop-registry', `${relOf(testPath)} names scripts/port-tick/cases/overrides.cases.json, which does not resolve to a real file`);
      }
    }
  }

  // --- Excused-check pin: effective.ts and config.ts share the same anchor ----
  // guard(#300): a prior ticket's comment claimed this pin existed before
  // this one actually asserted it — the two-space-indent assumption and the
  // job-name
  // regex drifting apart would silently misresolve which check the approval
  // gate excuses.
  // pin: `apps/desktop/src/main/registry/effective.ts`'s `parseExcusedCheckName` anchor (`'\njobs:'`, `/\n {2}([A-Za-z0-9_-]+):/`) ↔ `scripts/port-tick/config.ts`'s `resolveExcusedCheckName`, both directions
  {
    const effectiveText = readFileSync(join(root, 'apps/desktop/src/main/registry/effective.ts'), 'utf8');
    const configText = readFileSync(join(root, 'scripts/port-tick/config.ts'), 'utf8');
    for (const [label, text] of [
      ['apps/desktop/src/main/registry/effective.ts', effectiveText],
      ['scripts/port-tick/config.ts', configText],
    ] as const) {
      if (!text.includes("'\\njobs:'")) {
        fail('desktop-registry', `${label} does not carry the '\\njobs:' anchor`);
      } else if (!text.includes('/\\n {2}([A-Za-z0-9_-]+):/')) {
        fail('desktop-registry', `${label} does not carry the /\\n {2}([A-Za-z0-9_-]+):/ regex literal`);
      } else {
        ok();
      }
    }
  }

  // --- Wiring: effective.ts calls parseOverrides(/applyOverrides(, and -------
  // inspect.ts calls resolveEffectiveConfig(
  // guard(#300): deleting the call silently reverts the app to ignoring the
  // CLAUDE.md overrides block entirely, with no runtime failure to catch it.
  // pin: `apps/desktop/src/main/registry/effective.ts` calls `parseOverrides(`/`applyOverrides(` ↔ `apps/desktop/src/main/registry/inspect.ts` calls `resolveEffectiveConfig(`
  {
    const effectiveText = readFileSync(join(root, 'apps/desktop/src/main/registry/effective.ts'), 'utf8');
    const inspectText = readFileSync(join(root, 'apps/desktop/src/main/registry/inspect.ts'), 'utf8');
    if (!effectiveText.includes('parseOverrides(') || !effectiveText.includes('applyOverrides(')) {
      fail('desktop-registry', "main/registry/effective.ts does not call both parseOverrides( and applyOverrides(");
    } else {
      ok();
    }
    if (!inspectText.includes('resolveEffectiveConfig(')) {
      fail('desktop-registry', 'main/registry/inspect.ts does not call resolveEffectiveConfig(');
    } else {
      ok();
    }
  }

  // --- Retirement: withdraw-unverifiable / claude-md-overrides / unverifiable: -
  // appear in no file under apps/desktop/src/
  // guard(#300): the retired kind, problem reason, or disposition field
  // silently reverting instead of staying retired (the 'budget-unported'
  // precedent, scripts/checks/desktop-dispatch.ts).
  {
    const srcDir = join(root, 'apps/desktop/src');
    const retiredTerms = ['withdraw-unverifiable', 'claude-md-overrides', 'unverifiable:'];
    let found = false;
    for (const f of walk(srcDir).filter((p) => p.endsWith('.ts') || p.endsWith('.tsx'))) {
      const rel = relOf(f);
      const text = readFileSync(f, 'utf8');
      for (const term of retiredTerms) {
        if (text.includes(term)) {
          found = true;
          fail('desktop-registry', `${rel} still names '${term}' — #300 retired it once the app applies CLAUDE.md overrides itself`);
        }
      }
    }
    if (!found) ok();
  }
}
