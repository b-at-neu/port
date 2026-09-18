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
  // guard: two files listing the same vocabulary and drifting. Two files
  // independently list the same label keys. They have drifted before.
  {
    const templateKeys = new Set(readJson('plugins/port/data/labels.json').labels.map((l) => l.key));
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
  // guard(#61, #170): the cockpit resolving a config key it cannot map to a
  // real label name, and the role field the blocking-label derivation reads
  // from drifting from the table it was copied from. The cockpit resolves
  // `labels[key] ?? default` from an inline copy of the vocabulary rather
  // than reading labels.json directly, so the two tables must name the same
  // keys and the same default name per key. Extended for the role column:
  // it is what the workflow-render check below derives `{{blockingLabels}}`
  // from, so it is pinned against `labels.json`'s own `role` field too, both
  // directions.
  {
    // issue 181: the inline vocabulary table is Startup preflight step 5, which
    // moved into PREFLIGHT.md — a structural table parse, so this names one
    // file directly rather than the skill union.
    const skillRel = 'plugins/port/skills/pipeline/PREFLIGHT.md';
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
        readJson('plugins/port/data/labels.json').labels.map((l) => [l.key, { name: l.name, role: l.role }]),
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

  // --- No config key appears as a literal --label argument --------------------
  // guard(#61, #148): a key typed where a resolved label name belongs,
  // matching nothing silently, and a config key surviving the tick's
  // collapse into a GraphQL query and matching nothing silently — the exact
  // same failure mode one syntax over. `gh ... --label <unknown>` exits 0
  // with an empty result, so a config key (e.g. `planApproved`) typed
  // directly into a `--label`/`--add-label`/`--remove-label` argument
  // silently matches no real label instead of erroring. `<labels.planApproved>`
  // is the placeholder and must not match; the bare string `planApproved`
  // must. Extended for the collapsed tick query, which expresses the same
  // thing as a GraphQL `labels: [...]` list, which the original regex —
  // keyed on `--label` flags only — would silently miss.
  {
    const mismatched = readJson('plugins/port/data/labels.json')
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

  // --- Desktop app's LABEL_ROLES matches labels.json's role field, both directions ---
  // guard(#79): the stage ladder's role union drifting from the template it
  // must read. Decision 1: the stage ladder reads `role` off `LABEL_DEFAULTS`
  // rather than a hand-transcribed key→stage table. `LabelRole` itself can't
  // be derived from the template import (TypeScript widens JSON strings to
  // `string`), so it is hand-maintained in shared/labels/defaults.ts and must
  // agree with every distinct role labels.json actually uses, both ways.
  {
    const rel = 'apps/desktop/src/shared/labels/defaults.ts';
    const text = readFileSync(join(root, rel), 'utf8');
    const m = /LABEL_ROLES\s*=\s*\[([^\]]*)\]\s*as const/.exec(text);
    if (!m) {
      fail('labels', `${rel} has no 'LABEL_ROLES = [...] as const' array`);
    } else {
      const declaredRoles = new Set([...m[1].matchAll(/'([^']+)'/g)].map((t) => t[1]));
      const realRoles = new Set(readJson('plugins/port/data/labels.json').labels.map((l) => l.role));
      for (const r of declaredRoles) {
        if (!realRoles.has(r)) fail('labels', `${rel}'s LABEL_ROLES has '${r}', which no labels.json entry uses`);
      }
      for (const r of realRoles) {
        if (!declaredRoles.has(r)) fail('labels', `labels.json uses role '${r}', missing from ${rel}'s LABEL_ROLES`);
      }
      ok();
    }
  }

  // --- Label colours are well-formed and distinct -----------------------------
  // guard: a role's ramp collapsing back to one repeated hex. Every label's
  // position within its role ramp depends on a unique hex; a duplicate
  // collapses two labels back to pixel-identical, silently.
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

  // --- Workflow copies stay rendered from their templates ---------------------
  // guard(#170): the live workflow that actually gates merges drifting
  // silently from the template every adopter installs, or vice versa.
  // `.github/workflows/approval-check.yml` and `artifacts.yml` are rendered
  // copies of `plugins/port/templates/*.yml` with the substitutions applied.
  // Nothing pinned them together.
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
    const labelDefs = readJson('plugins/port/data/labels.json').labels;
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
  // guard(#75): the one literal union that can't be derived from the JSON
  // import (TypeScript widens JSON strings to `string`) drifting from the
  // template it must mirror. apps/desktop imports the shipped template
  // directly (it can — same repository, bundled at build time), so there is
  // no second transcription to drift there, but LABEL_KEYS itself must be
  // diffed against the template here, the same shape as the cockpit-table
  // and artifacts-labels guards above.
  {
    const rel = 'apps/desktop/src/shared/labels/vocabulary.ts';
    const text = readFileSync(join(root, rel), 'utf8');
    const m = /LABEL_KEYS\s*=\s*\[([^\]]*)\]\s*as const/.exec(text);
    if (!m) {
      fail('desktop-label-defaults', `${rel} has no 'LABEL_KEYS = [...] as const' array`);
    } else {
      const desktopKeys = new Set([...m[1].matchAll(/'([^']+)'/g)].map((t) => t[1]));
      const templateKeys = new Set(readJson('plugins/port/data/labels.json').labels.map((l) => l.key));
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
  // guard(#75, #74): the app retyping a resolved label name by hand instead
  // of reading it from the LABEL_DEFAULTS import — the same
  // second-transcription drift this rail exists to prevent — and the
  // registry or the renderer retyping a resolved label name instead of
  // importing it, now that both are consumers. The strings where
  // `key !== name` (`plan approved`, `ready for review`, …) must come from
  // the LABEL_DEFAULTS import, never be hand-typed again. Single-word names
  // where `key === name` are excluded, since LABEL_KEYS legitimately
  // contains them as literals. Widened from shared/labels/ to all of
  // apps/desktop/src/.
  {
    const mismatched = readJson('plugins/port/data/labels.json')
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
