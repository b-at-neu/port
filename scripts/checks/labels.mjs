import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, readJson, walk, relOf } from '../lib/files.mjs';

export default async function ({ fail, ok }) {
  // --- Label vocabulary matches the schema -----------------------------------
  // Two files independently list the same label keys. They have drifted before.
  {
    const templateKeys = new Set(readJson('plugins/port/templates/labels.json').labels.map((l) => l.key));
    const schemaKeys = new Set(
      Object.keys(readJson('schema/port.config.schema.json').properties.labels.properties),
    );
    for (const k of templateKeys) {
      if (!schemaKeys.has(k)) fail('labels', `'${k}' is in labels.json but not the schema`);
    }
    for (const k of schemaKeys) {
      if (!templateKeys.has(k)) fail('labels', `'${k}' is in the schema but not labels.json`);
    }
    ok();
  }

  // --- Cockpit's inline label-vocabulary table matches labels.json ------------
  // Regression guard for #61: the cockpit resolves `labels[key] ?? default` from
  // an inline copy of the vocabulary rather than reading labels.json directly,
  // so the two tables must name the same keys and the same default name per key
  // or the resolution the cockpit performs at startup silently drifts from the
  // source of truth.
  {
    const skillRel = 'plugins/port/skills/pipeline/SKILL.md';
    const skillText = readFileSync(join(root, skillRel), 'utf8');
    const tableMatch =
      /\| Config key \| Default name \| Role \| Module \|\n[ \t]*\|[-\s|]+\|\n((?:[ \t]*\|.*\|\n?)+)/.exec(
        skillText,
      );
    if (!tableMatch) {
      fail('label-vocabulary', `${skillRel} is missing the inline 'Config key | Default name' table`);
    } else {
      const inline = new Map();
      for (const line of tableMatch[1].split('\n')) {
        const row = /^[ \t]*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/.exec(line);
        if (row) inline.set(row[1], row[2]);
      }
      const canonical = new Map(
        readJson('plugins/port/templates/labels.json').labels.map((l) => [l.key, l.name]),
      );
      for (const [key, name] of inline) {
        if (!canonical.has(key)) {
          fail('label-vocabulary', `${skillRel} lists key '${key}', which is not in templates/labels.json`);
        } else if (canonical.get(key) !== name) {
          fail(
            'label-vocabulary',
            `${skillRel} names '${key}' as '${name}', but templates/labels.json says '${canonical.get(key)}'`,
          );
        }
      }
      for (const [key, name] of canonical) {
        if (!inline.has(key)) {
          fail('label-vocabulary', `templates/labels.json has key '${key}' ('${name}'), missing from ${skillRel}'s inline table`);
        }
      }
      ok();
    }
  }

  // --- No config key appears as a literal --label argument --------------------
  // Regression guard for #61: `gh ... --label <unknown>` exits 0 with an empty
  // result, so a config key (e.g. `planApproved`) typed directly into a
  // `--label`/`--add-label`/`--remove-label` argument silently matches no real
  // label instead of erroring. `<labels.planApproved>` is the placeholder and
  // must not match; the bare string `planApproved` must. Extended for #148: the
  // collapsed tick query expresses the same thing as a GraphQL `labels: [...]`
  // list, which the original regex — keyed on `--label` flags only — would
  // silently miss, letting the collapse reintroduce #61's exact failure mode
  // one syntax over.
  {
    const mismatched = readJson('plugins/port/templates/labels.json')
      .labels.filter((l) => l.key !== l.name)
      .map((l) => l.key);
    const files = walk(join(root, 'plugins')).filter((f) => f.endsWith('.md'));
    for (const f of files) {
      const rel = relOf(f);
      const text = readFileSync(f, 'utf8');
      const flagRe = /--(?:add-|remove-)?label\s+"([^"]*)"/g;
      let m;
      while ((m = flagRe.exec(text))) {
        const tokens = m[1].split(',').map((t) => t.trim());
        for (const token of tokens) {
          if (mismatched.includes(token)) {
            fail(
              'label-vocabulary',
              `${rel}: '${m[0]}' uses the config key '${token}' as a literal label name`,
            );
          }
        }
      }

      const graphqlRe = /labels:\s*\[([^\]]*)\]/g;
      while ((m = graphqlRe.exec(text))) {
        const tokens = [...m[1].matchAll(/"([^"]*)"/g)].map((t) => t[1]);
        for (const token of tokens) {
          if (mismatched.includes(token)) {
            fail(
              'label-vocabulary',
              `${rel}: GraphQL '${m[0]}' uses the config key '${token}' as a literal label name`,
            );
          }
        }
      }
    }
    ok();
  }

  // --- Label colours are well-formed and distinct -----------------------------
  // Every label's position within its role ramp depends on a unique hex; a
  // duplicate collapses two labels back to pixel-identical, silently.
  {
    const labels = readJson('plugins/port/templates/labels.json').labels;
    const seen = new Map();
    for (const l of labels) {
      if (!/^[0-9A-F]{6}$/.test(l.color)) {
        fail('label-colors', `'${l.key}' has a malformed color '${l.color}', expected six uppercase hex digits`);
        continue;
      }
      if (seen.has(l.color)) {
        fail('label-colors', `'${l.key}' and '${seen.get(l.color)}' share color '${l.color}'`);
      } else {
        seen.set(l.color, l.key);
      }
    }
    ok();
  }

  // --- Desktop app's LABEL_KEYS matches labels.json, both directions ---------
  // #75: apps/desktop imports the shipped template directly (it can — same
  // repository, bundled at build time), so there is no second transcription to
  // drift. But LABEL_KEYS itself can't be derived from that import (TypeScript
  // widens JSON string values to `string`), so it is hand-maintained in
  // vocabulary.ts and must be diffed against the template here, the same shape
  // as the cockpit-table and artifacts-labels guards above.
  {
    const rel = 'apps/desktop/src/shared/labels/vocabulary.ts';
    const text = readFileSync(join(root, rel), 'utf8');
    const m = /LABEL_KEYS\s*=\s*\[([^\]]*)\]\s*as const/.exec(text);
    if (!m) {
      fail('desktop-label-defaults', `${rel} has no 'LABEL_KEYS = [...] as const' array`);
    } else {
      const desktopKeys = new Set([...m[1].matchAll(/'([^']+)'/g)].map((t) => t[1]));
      const templateKeys = new Set(readJson('plugins/port/templates/labels.json').labels.map((l) => l.key));
      for (const k of desktopKeys) {
        if (!templateKeys.has(k)) fail('desktop-label-defaults', `${rel}'s LABEL_KEYS has '${k}', which is not in labels.json`);
      }
      for (const k of templateKeys) {
        if (!desktopKeys.has(k)) fail('desktop-label-defaults', `labels.json has key '${k}', missing from ${rel}'s LABEL_KEYS`);
      }
      ok();
    }
  }

  // --- Desktop app never retypes a resolved label name it should import ------
  // #75: the strings where `key !== name` (`plan approved`, `ready for review`,
  // …) must come from the LABEL_DEFAULTS import, never be hand-typed again —
  // that is exactly the second-transcription drift this ticket exists to
  // prevent. Single-word names where `key === name` are excluded, since
  // LABEL_KEYS legitimately contains them as literals.
  {
    const mismatched = readJson('plugins/port/templates/labels.json')
      .labels.filter((l) => l.key !== l.name)
      .map((l) => l.name);
    const dir = join(root, 'apps/desktop/src/shared/labels');
    for (const f of walk(dir).filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts'))) {
      const rel = relOf(f);
      const text = readFileSync(f, 'utf8');
      for (const name of mismatched) {
        if (text.includes(`'${name}'`) || text.includes(`"${name}"`)) {
          fail('desktop-label-defaults', `${rel}: literal '${name}' must come from the LABEL_DEFAULTS import, not be retyped`);
        }
      }
    }
    ok();
  }
}
