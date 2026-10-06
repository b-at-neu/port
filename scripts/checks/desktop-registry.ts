import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, readJson, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// The registry's config contract (defaults and validation) is read from
// schema/port.config.schema.json at runtime, never transcribed into TypeScript.

/** Walks only `tracker`/`branches`/`models`, collecting every leaf `default` typed `'string'`.
 *  Excludes `labels`: pinned by `labels.ts` separately, and its short names would collide. */
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

  // --- The shipped schema is imported by exactly one file — never re-derived instead of read. ---
  {
    const importers = files.filter((f) => schemaImportPattern.test(readFileSync(f, 'utf8')));
    if (importers.length === 0) {
      fail('desktop-registry', 'no file under apps/desktop/src/ imports schema/port.config.schema.json — the guard cannot pass vacuously if this file is deleted');
    } else expect(!(importers.length > 1), 'desktop-registry', `schema/port.config.schema.json is imported by ${importers.length} files, expected exactly one: ${importers.map(relOf).join(', ')}`);
  }

  // --- No file under main/registry/ retypes a string default as a literal — must come from the CONFIG_DEFAULTS import. ---
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

  // main/registry/effective.ts imports scripts/port-tick/overrides.ts directly — no app-owned copy left to drift.

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

  // pin: `apps/desktop/src/main/registry/effective.ts` calls `parseOverrides(`/`applyOverrides(` ↔ `apps/desktop/src/main/registry/inspect.ts` calls `resolveEffectiveConfig(`
  {
    const effectiveText = readFileSync(join(root, 'apps/desktop/src/main/registry/effective.ts'), 'utf8');
    const inspectText = readFileSync(join(root, 'apps/desktop/src/main/registry/inspect.ts'), 'utf8');
    expect(!(!effectiveText.includes('parseOverrides(') || !effectiveText.includes('applyOverrides(')), 'desktop-registry', "main/registry/effective.ts does not call both parseOverrides( and applyOverrides(");
    expect(inspectText.includes('resolveEffectiveConfig('), 'desktop-registry', 'main/registry/inspect.ts does not call resolveEffectiveConfig(');
  }

  // --- Retirement: withdraw-unverifiable / claude-md-overrides / unverifiable: appear in no
  // file under apps/desktop/src/ — the retired terms must never revert. ---
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
