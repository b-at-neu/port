import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { root, readJson, walk, relOf } from '../lib/files.mjs';

/** Substitutes every `{{name}}` in `text` with `subs[name]`. A multi-line
 *  value has its continuation lines indented to the leading whitespace of the
 *  line the placeholder sits on, which is what reproduces a YAML block
 *  scalar's own indentation (the shell strips it before it ever sees the
 *  value). Throws naming the placeholder if any `{{...}}` survives, so a
 *  template that gains a new one forces the caller's map to grow rather than
 *  being silently ignored. */
export function renderTemplate(text, subs) {
  const rendered = text
    .split('\n')
    .map((line) => {
      let out = line;
      for (const [name, value] of Object.entries(subs)) {
        const token = `{{${name}}}`;
        if (!out.includes(token)) continue;
        if (value.includes('\n')) {
          const indent = /^[ \t]*/.exec(line)[0];
          const indented = value
            .split('\n')
            .map((v, i) => (i === 0 ? v : `${indent}${v}`))
            .join('\n');
          out = out.split(token).join(indented);
        } else {
          out = out.split(token).join(value);
        }
      }
      return out;
    })
    .join('\n');
  // Deliberately excludes GitHub Actions' own `${{ expression }}` syntax — the
  // `$` prefix and the space/dot inside are what distinguish it from one of
  // this template's own `{{name}}` placeholders, which are bare identifiers.
  const leftover = /(?<!\$)\{\{[A-Za-z][A-Za-z0-9]*\}\}/.exec(rendered);
  if (leftover) throw new Error(`unresolved placeholder ${leftover[0]}`);
  return rendered;
}

/** Reduces `text` to an array of comparable entries: a run of consecutive
 *  full-line `#` comments at the same indent, with non-empty text, collapses
 *  to one `indent + whitespace-collapsed text` entry, tolerating reflow across
 *  a line break. A bare `#` line ends the run without merging into it. Every
 *  other line — including one with trailing code after a `#` — is kept
 *  verbatim (trailing whitespace stripped only), so a YAML indentation or
 *  wording change on a real line is never normalized away. */
export function normalizeYaml(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^([ \t]*)#(.*)$/.exec(lines[i]);
    if (m && m[2].trim() !== '') {
      const indent = m[1];
      const parts = [m[2].trim()];
      let j = i + 1;
      while (j < lines.length) {
        const next = /^([ \t]*)#(.*)$/.exec(lines[j]);
        if (next && next[1] === indent && next[2].trim() !== '') {
          parts.push(next[2].trim());
          j++;
        } else break;
      }
      out.push(`${indent}${parts.join(' ').replace(/[ \t]+/g, ' ')}`);
      i = j;
    } else {
      out.push(lines[i].replace(/[ \t]+$/, ''));
      i++;
    }
  }
  return out;
}

export default async function ({ fail, note, ok }) {
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
  // source of truth. Extended for #170: the table's Role column is what the
  // workflow-render check below derives `{{blockingLabels}}` from, so it is
  // pinned against `labels.json`'s own `role` field too, both directions.
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
        const row = /^[ \t]*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|/.exec(line);
        if (row) inline.set(row[1], { name: row[2], role: row[3] });
      }
      const canonical = new Map(
        readJson('plugins/port/templates/labels.json').labels.map((l) => [l.key, { name: l.name, role: l.role }]),
      );
      for (const [key, entry] of inline) {
        const c = canonical.get(key);
        if (!c) {
          fail('label-vocabulary', `${skillRel} lists key '${key}', which is not in templates/labels.json`);
        } else if (c.name !== entry.name) {
          fail(
            'label-vocabulary',
            `${skillRel} names '${key}' as '${entry.name}', but templates/labels.json says '${c.name}'`,
          );
        } else if (c.role !== entry.role) {
          fail(
            'label-vocabulary',
            `${skillRel} gives '${key}' role '${entry.role}', but templates/labels.json says '${c.role}'`,
          );
        }
      }
      for (const [key, entry] of canonical) {
        if (!inline.has(key)) {
          fail('label-vocabulary', `templates/labels.json has key '${key}' ('${entry.name}'), missing from ${skillRel}'s inline table`);
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

  // --- Workflow copies stay rendered from their templates (#170) --------------
  // `.github/workflows/approval-check.yml` and `artifacts.yml` are rendered
  // copies of `plugins/port/templates/*.yml` with the substitutions applied.
  // Nothing pinned them together, so a fix applied to the live workflow — the
  // copy that actually gates this repository's merges — could drift silently
  // from the template every adopter installs, and vice versa.
  {
    // Self-test both helpers first — a check that cannot be made to fail is not
    // a check.
    {
      const a = normalizeYaml('# one\n# two three\ncode: here');
      const b = normalizeYaml('# one two\n# three\ncode: here');
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        fail('workflow-templates', 'normalizeYaml: reflowing a comment across a line break must compare equal');
      } else {
        ok();
      }
    }
    {
      const a = normalizeYaml('code: here');
      const b = normalizeYaml('code: there');
      if (JSON.stringify(a) === JSON.stringify(b)) {
        fail('workflow-templates', 'normalizeYaml: a changed word on a non-comment line must compare unequal');
      } else {
        ok();
      }
    }
    {
      const a = normalizeYaml('  code: here');
      const b = normalizeYaml('    code: here');
      if (JSON.stringify(a) === JSON.stringify(b)) {
        fail('workflow-templates', 'normalizeYaml: a changed indent on a non-comment line must compare unequal');
      } else {
        ok();
      }
    }
    {
      const rendered = renderTemplate('          X="{{v}}"', { v: 'a\nb\nc' });
      if (rendered !== '          X="a\n          b\n          c"') {
        fail(
          'workflow-templates',
          `renderTemplate: a multi-line value's continuation lines must indent to the placeholder's own column, got ${JSON.stringify(rendered)}`,
        );
      } else {
        ok();
      }
    }

    const cfg = readJson('.claude/port.config.json');
    const labelDefs = readJson('plugins/port/templates/labels.json').labels;
    const resolvedName = (key) => cfg.labels?.[key] ?? labelDefs.find((l) => l.key === key).name;
    const blockingLabels = labelDefs
      .filter((l) => l.role === 'in-flight' || l.role === 'gate')
      .filter((l) => l.module === 'core' || cfg.modules?.[l.module])
      .map((l) => resolvedName(l.key))
      .join('\n');

    const pairs = [
      {
        label: 'approval-check.yml',
        templateRel: 'plugins/port/templates/approval-check.yml',
        liveRel: '.github/workflows/approval-check.yml',
        enabled: cfg.modules?.approvalGate === true,
        disabledNote: 'modules.approvalGate is off',
        subs: {
          integration: cfg.branches.integration,
          production: cfg.branches.production,
          approvedLabel: resolvedName('approved'),
          markerLabel: resolvedName('marker'),
          blockingLabels,
        },
      },
      {
        label: 'artifacts.yml',
        templateRel: 'plugins/port/templates/artifacts.yml',
        liveRel: '.github/workflows/artifacts.yml',
        enabled: typeof cfg.commands?.artifacts === 'string' && cfg.commands.artifacts.length > 0,
        disabledNote: 'commands.artifacts is not set',
        subs: {
          approvedLabel: resolvedName('approved'),
          markerLabel: resolvedName('marker'),
          artifactsCommand: cfg.commands?.artifacts,
        },
      },
    ];

    for (const pair of pairs) {
      if (!pair.enabled) {
        note(`workflow-templates: ${pair.label} skipped — ${pair.disabledNote}`);
        continue;
      }
      const templatePath = join(root, pair.templateRel);
      const livePath = join(root, pair.liveRel);
      if (!existsSync(templatePath) || !existsSync(livePath)) {
        fail('workflow-templates', `${pair.templateRel} or ${pair.liveRel} is missing while ${pair.label}'s gate is enabled`);
        continue;
      }
      let renderedTemplate;
      try {
        renderedTemplate = renderTemplate(readFileSync(templatePath, 'utf8'), pair.subs);
      } catch (e) {
        fail('workflow-templates', `${pair.templateRel}: ${e.message} — extend the substitution map`);
        continue;
      }
      const templateLines = normalizeYaml(renderedTemplate);
      const liveLines = normalizeYaml(readFileSync(livePath, 'utf8'));
      const len = Math.max(templateLines.length, liveLines.length);
      let mismatch = -1;
      for (let idx = 0; idx < len; idx++) {
        if (templateLines[idx] !== liveLines[idx]) {
          mismatch = idx;
          break;
        }
      }
      if (mismatch === -1) {
        ok();
      } else {
        fail(
          'workflow-templates',
          `${pair.liveRel} differs from ${pair.templateRel} rendered, at entry ${mismatch}: ` +
            `template renders ${JSON.stringify(templateLines[mismatch])}, live has ${JSON.stringify(liveLines[mismatch])} — ` +
            `update ${pair.liveRel} to match ${pair.templateRel} (the template is the source, the workflow is its render)`,
        );
      }
    }
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
  // LABEL_KEYS legitimately contains them as literals. Widened for #74 from
  // shared/labels/ to all of apps/desktop/src/: the registry and the
  // renderer are consumers now too, not just the one directory that had a
  // consumer when this guard was written.
  {
    const mismatched = readJson('plugins/port/templates/labels.json')
      .labels.filter((l) => l.key !== l.name)
      .map((l) => l.name);
    const dir = join(root, 'apps/desktop/src');
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
