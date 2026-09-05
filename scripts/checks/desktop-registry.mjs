import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, readJson, walk, relOf } from '../lib/files.mjs';

// #74: the registry's config contract (defaults and validation) is read from
// schema/port.config.schema.json at runtime, never transcribed into
// TypeScript (ENGINEERING §1, decisions 1-2). Two assertions pin that, in the
// shape of desktop-platform.mjs's own guards.

/** Walks only the schema sub-trees `CONFIG_DEFAULTS` (plus `tracker`, read
 *  the same way elsewhere) actually reads — `tracker`, `branches`, `models`
 *  — collecting every leaf `default` whose declared `type` is `'string'`.
 *  Deliberately excludes `labels`: those defaults are a different contract,
 *  already pinned by `labels.mjs`'s own guard, and its ~18 short label
 *  names (`ready`, `blocked`, …) would otherwise collide with unrelated
 *  identifiers throughout the registry's own code. */
function collectStringDefaults(schema) {
  const roots = [schema.properties.tracker, schema.properties.branches, schema.properties.models];
  const defaults = new Set();
  function walkNode(node) {
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

export default async function ({ fail, ok }) {
  const srcDir = join(root, 'apps/desktop/src');
  const files = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  const schemaImportPattern = /['"](?:\.\.\/)+schema\/port\.config\.schema\.json['"]/;

  // --- The shipped schema is imported by exactly one file, and it is imported ---
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
}
