import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

export default async function ({ expect, fail, ok }: Reporter) {
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
    } else expect(!(importers.length > 1), 'desktop-registry', `schema/port.config.schema.json is imported by ${importers.length} files, expected exactly one: ${importers.map(relOf).join(', ')}`);
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

  // #348: main/registry/effective.ts imports scripts/port-tick/overrides.ts
  // directly — there is no app-owned copy left to drift, so the former
  // port/case-table pins above are gone with it (desktop-tick's (3)/(4)/(8)/
  // (11) retired the same way for the tick decision families).

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
      } else expect(text.includes('/\\n {2}([A-Za-z0-9_-]+):/'), 'desktop-registry', `${label} does not carry the /\\n {2}([A-Za-z0-9_-]+):/ regex literal`);
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
    expect(!(!effectiveText.includes('parseOverrides(') || !effectiveText.includes('applyOverrides(')), 'desktop-registry', "main/registry/effective.ts does not call both parseOverrides( and applyOverrides(");
    expect(inspectText.includes('resolveEffectiveConfig('), 'desktop-registry', 'main/registry/inspect.ts does not call resolveEffectiveConfig(');
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
