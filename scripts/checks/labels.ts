import { readFileSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { root, readJson, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';
import { message } from '../lib/errors.ts';

/** Substitutes every `{{name}}` in `text` with `subs[name]`. A multi-line value has its
 *  continuation lines indented to its placeholder's own column. Throws naming any surviving placeholder, so a new one forces the caller's map to grow. */
export function renderTemplate(text: string, subs: Record<string, string>): string {
  const rendered = text
    .split('\n')
    .map((line) => {
      let out = line;
      for (const [name, value] of Object.entries(subs)) {
        const token = `{{${name}}}`;
        if (!out.includes(token)) continue;
        if (value.includes('\n')) {
          const indent = /^[ \t]*/.exec(line)![0];
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
  // Deliberately excludes GitHub Actions' own `${{ expression }}` syntax — the `$` prefix distinguishes it from a bare `{{name}}` placeholder.
  const leftover = /(?<!\$)\{\{[A-Za-z][A-Za-z0-9]*\}\}/.exec(rendered);
  if (leftover) throw new Error(`unresolved placeholder ${leftover[0]}`);
  return rendered;
}

/** Reduces `text` to comparable entries: a run of consecutive full-line `#` comments at the
 *  same indent collapses to one entry, tolerating reflow. Every other line is kept verbatim (trailing whitespace stripped only). */
export function normalizeYaml(text: string): string[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const out: string[] = [];
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

export default async function ({ expect, fail, note, ok }: Reporter) {
  // --- Label vocabulary matches the schema — two files independently list the same label
  // keys, and have drifted before. pin: `data/labels.json` ↔ the schema
  {
    const templateKeys = new Set<string>(readJson('plugins/port/data/labels.json').labels.map((l: any) => l.key));
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

  // pin: `pipeline/SKILL.md`'s inline label table ↔ `labels.json`
  {
    // The inline vocabulary table lives in PREFLIGHT.md — a structural table parse, so this names one file directly rather than the skill union.
    const skillRel = 'plugins/port/skills/pipeline/PREFLIGHT.md';
    const skillText = readFileSync(join(root, skillRel), 'utf8');
    const tableMatch =
      /\| Config key \| Default name \| Role \| Module \|\n[ \t]*\|[-\s|]+\|\n((?:[ \t]*\|.*\|\n?)+)/.exec(
        skillText,
      );
    if (!tableMatch) {
      fail('label-vocabulary', `${skillRel} is missing the inline 'Config key | Default name' table`);
    } else {
      const inline = new Map<string, any>();
      for (const line of tableMatch[1].split('\n')) {
        const row = /^[ \t]*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|/.exec(line);
        if (row) inline.set(row[1], { name: row[2], role: row[3] });
      }
      const canonical = new Map<string, any>(
        readJson('plugins/port/data/labels.json').labels.map((l: any) => [l.key, { name: l.name, role: l.role }]),
      );
      for (const [key, entry] of inline) {
        const c = canonical.get(key);
        if (!c) {
          fail('label-vocabulary', `${skillRel} lists key '${key}', which is not in data/labels.json`);
        } else if (c.name !== entry.name) {
          fail(
            'label-vocabulary',
            `${skillRel} names '${key}' as '${entry.name}', but data/labels.json says '${c.name}'`,
          );
        } else if (c.role !== entry.role) {
          fail(
            'label-vocabulary',
            `${skillRel} gives '${key}' role '${entry.role}', but data/labels.json says '${c.role}'`,
          );
        }
      }
      for (const [key, entry] of canonical) {
        if (!inline.has(key)) {
          fail('label-vocabulary', `data/labels.json has key '${key}' ('${entry.name}'), missing from ${skillRel}'s inline table`);
        }
      }
      ok();
    }
  }

  // --- No config key appears as a literal --label argument — `gh ... --label <unknown>`
  // exits 0 with an empty result, so a config key typed directly matches nothing silently. Also checked against the collapsed tick query's GraphQL `labels: [...]` list. ---
  {
    const mismatched = readJson('plugins/port/data/labels.json')
      .labels.filter((l: any) => l.key !== l.name)
      .map((l: any) => l.key);
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

  // --- Desktop app's LABEL_ROLES matches labels.json's role field, both directions — hand-
  // maintained in shared/labels/defaults.ts since TypeScript widens JSON strings, so it must agree with every distinct role labels.json uses. ---
  {
    const rel = 'apps/desktop/src/shared/labels/defaults.ts';
    const text = readFileSync(join(root, rel), 'utf8');
    const m = /LABEL_ROLES\s*=\s*\[([^\]]*)\]\s*as const/.exec(text);
    if (!m) {
      fail('labels', `${rel} has no 'LABEL_ROLES = [...] as const' array`);
    } else {
      const declaredRoles = new Set([...m[1].matchAll(/'([^']+)'/g)].map((t) => t[1]));
      const realRoles = new Set<string>(readJson('plugins/port/data/labels.json').labels.map((l: any) => l.role));
      for (const r of declaredRoles) {
        if (!realRoles.has(r)) fail('labels', `${rel}'s LABEL_ROLES has '${r}', which no labels.json entry uses`);
      }
      for (const r of realRoles) {
        if (!declaredRoles.has(r)) fail('labels', `labels.json uses role '${r}', missing from ${rel}'s LABEL_ROLES`);
      }
      ok();
    }
  }

  // --- Label colours are well-formed and distinct — every label's position within its role
  // ramp depends on a unique hex; a duplicate collapses two labels pixel-identical, silently. ---
  {
    const labels = readJson('plugins/port/data/labels.json').labels;
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

  // pin: `.github/workflows/*.yml` ↔ `plugins/port/templates/*.yml` — the live workflow that
  // gates merges must never drift silently from the template every adopter installs.
  {
    // Self-test both helpers first.
    {
      const a = normalizeYaml('# one\n# two three\ncode: here');
      const b = normalizeYaml('# one two\n# three\ncode: here');
      expect(!(JSON.stringify(a) !== JSON.stringify(b)), 'workflow-templates', 'normalizeYaml: reflowing a comment across a line break must compare equal');
    }
    {
      const a = normalizeYaml('code: here');
      const b = normalizeYaml('code: there');
      expect(!(JSON.stringify(a) === JSON.stringify(b)), 'workflow-templates', 'normalizeYaml: a changed word on a non-comment line must compare unequal');
    }
    {
      const a = normalizeYaml('  code: here');
      const b = normalizeYaml('    code: here');
      expect(!(JSON.stringify(a) === JSON.stringify(b)), 'workflow-templates', 'normalizeYaml: a changed indent on a non-comment line must compare unequal');
    }
    {
      const rendered = renderTemplate('          X="{{v}}"', { v: 'a\nb\nc' });
      expect(!(rendered !== '          X="a\n          b\n          c"'), 'workflow-templates', `renderTemplate: a multi-line value's continuation lines must indent to the placeholder's own column, got ${JSON.stringify(rendered)}`);
    }

    const cfg = readJson('.claude/port.config.json');
    const labelDefs = readJson('plugins/port/data/labels.json').labels;
    const resolvedName = (key: string): string => cfg.labels?.[key] ?? labelDefs.find((l: any) => l.key === key).name;
    const blockingLabels = labelDefs
      .filter((l: any) => l.role === 'in-flight' || l.role === 'gate')
      .filter((l: any) => l.module === 'core' || cfg.modules?.[l.module])
      .map((l: any) => resolvedName(l.key))
      .join('\n');

    const pairs: { label: string; templateRel: string; liveRel: string; enabled: boolean; disabledNote: string; subs: Record<string, string> }[] = [
      {
        label: 'approval-check.yml',
        templateRel: 'plugins/port/templates/approval-check.yml',
        liveRel: '.github/workflows/approval-check.yml',
        enabled: cfg.modules?.approvalGate === true,
        disabledNote: 'modules.approvalGate is off',
        subs: {
          integration: cfg.branches.integration,
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
      let renderedTemplate: string;
      try {
        renderedTemplate = renderTemplate(readFileSync(templatePath, 'utf8'), pair.subs);
      } catch (e) {
        fail('workflow-templates', `${pair.templateRel}: ${message(e)} — extend the substitution map`);
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

  // pin: `apps/desktop`'s `LABEL_KEYS` ↔ `labels.json` — the one literal union that can't be
  // derived from the JSON import (TypeScript widens JSON strings to `string`) must be diffed here instead.
  {
    const rel = 'apps/desktop/src/shared/labels/vocabulary.ts';
    const text = readFileSync(join(root, rel), 'utf8');
    const m = /LABEL_KEYS\s*=\s*\[([^\]]*)\]\s*as const/.exec(text);
    if (!m) {
      fail('desktop-label-defaults', `${rel} has no 'LABEL_KEYS = [...] as const' array`);
    } else {
      const desktopKeys = new Set([...m[1].matchAll(/'([^']+)'/g)].map((t) => t[1]));
      const templateKeys = new Set<string>(readJson('plugins/port/data/labels.json').labels.map((l: any) => l.key));
      for (const k of desktopKeys) {
        if (!templateKeys.has(k)) fail('desktop-label-defaults', `${rel}'s LABEL_KEYS has '${k}', which is not in labels.json`);
      }
      for (const k of templateKeys) {
        if (!desktopKeys.has(k)) fail('desktop-label-defaults', `labels.json has key '${k}', missing from ${rel}'s LABEL_KEYS`);
      }
      ok();
    }
  }

  // --- Desktop app never retypes a resolved label name it should import — every string where
  // `key !== name` must come from LABEL_DEFAULTS. `main/platform/`/`main/runtime/` excluded: their `'claude'` hits are the CLI binary name. ---
  {
    const mismatched = readJson('plugins/port/data/labels.json')
      .labels.filter((l: any) => l.key !== l.name)
      .map((l: any) => l.name);
    const dir = join(root, 'apps/desktop/src');
    const labelFreeDirs = [join(dir, 'main/platform'), join(dir, 'main/runtime')];
    for (const f of walk(dir).filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts') && !labelFreeDirs.some((d) => p === d || p.startsWith(`${d}${sep}`)))) {
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
