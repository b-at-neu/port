import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson, pipelineSkillText } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

const ENGINE_REL = 'scripts/port-tick/overrides.ts';

export default async function ({ expect, fail, note, ok }: Reporter) {
  const engine: any = await import(pathToFileURL(join(root, ENGINE_REL)).href);
  const OVERRIDABLE: string[] = engine.OVERRIDABLE;
  const NEVER_OVERRIDABLE: string[] = engine.NEVER_OVERRIDABLE;
  const PERMISSION_SURFACE: Set<string> = engine.PERMISSION_SURFACE;
  const { parseOverrides, applyOverrides, BEGIN, END } = engine;

  // pin: `schema/port.config.schema.json`'s top-level keys ↔ `scripts/port-tick/overrides.ts`'s `OVERRIDABLE`/`NEVER_OVERRIDABLE`, both directions
  {
    const schema = readJson('schema/port.config.schema.json');
    const schemaKeys = new Set(Object.keys(schema.properties ?? {}));

    const overridableTop = new Set(OVERRIDABLE.map((p) => p.split('.')[0]));
    const neverTop = new Set(NEVER_OVERRIDABLE);

    for (const key of overridableTop) {
      if (key === 'checks') continue; // synthetic — asserted separately below
      expect(schemaKeys.has(key), 'overrides-schema', `${ENGINE_REL}'s OVERRIDABLE names top-level category '${key}', which the schema does not carry`);
    }
    for (const key of neverTop) {
      expect(schemaKeys.has(key), 'overrides-schema', `${ENGINE_REL}'s NEVER_OVERRIDABLE names '${key}', which the schema does not carry`);
    }
    for (const key of schemaKeys) {
      if (key === '$schema') continue; // meta pointer, not a config category
      expect(!(!overridableTop.has(key) && !neverTop.has(key)), 'overrides-schema', `schema top-level key '${key}' is classified as neither overridable nor never-overridable in ${ENGINE_REL} — a key added later must be classified explicitly`);
    }

    // 'checks' is synthetic and must never also collide with a real schema key.
    expect(!schemaKeys.has('checks'), 'overrides-schema', `the schema now carries a real 'checks' top-level key, which collides with the synthetic override category of the same name`);

    // The permission surface is refused by name, and is a subset of NEVER_OVERRIDABLE.
    for (const key of PERMISSION_SURFACE) {
      expect(neverTop.has(key), 'overrides-schema', `PERMISSION_SURFACE names '${key}', which NEVER_OVERRIDABLE does not carry`);
    }
  }

  // --- labels.<key> resolves against data/labels.json — an override naming a nonexistent key must never apply anyway. ---
  {
    const labelsJson = readJson('plugins/port/data/labels.json');
    const labelKeys = labelsJson.labels.map((l: any) => l.key);
    const baseCfg = {
      integration: 'dev',
      production: 'main',
      labels: Object.fromEntries(labelKeys.map((k: string) => [k, k])),
      models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
      modules: { approvalGate: true, release: true, scope: true },
      reviewCycleCap: 5,
      concurrency: { sharedFiles: [], overlapThreshold: 2 },
      sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
    };

    const realKey = labelKeys[0];
    const goodEntry = { path: `labels.${realKey}`, op: '=' as const, rawValue: 'renamed', reason: 'this repo already used this word', line: '' };
    const goodResult = applyOverrides(baseCfg, { entries: [goodEntry], problems: [] }, { labelKeys });
    expect(!(goodResult.refused.length !== 0 || goodResult.applied.length !== 1), 'overrides-labels', `applyOverrides refused a labels.${realKey} override naming a real label key`);

    const badEntry = { path: 'labels.notARealKey', op: '=' as const, rawValue: 'x', reason: 'typo', line: '' };
    const badResult = applyOverrides(baseCfg, { entries: [badEntry], problems: [] }, { labelKeys });
    expect(!(badResult.applied.length !== 0 || badResult.refused.length !== 1), 'overrides-labels', 'applyOverrides applied labels.notARealKey — the label key set was never checked');
  }

  // pin: `plugins/port/docs/PIPELINE.md`'s "CLAUDE.md overrides" category table ↔ `scripts/port-tick/overrides.ts`'s `OVERRIDABLE`/`NEVER_OVERRIDABLE`/`BEGIN`/`END`
  {
    const pipelineText = readFileSync(join(root, 'plugins/port/docs/PIPELINE.md'), 'utf8');
    expect(pipelineText.includes('## CLAUDE.md overrides'), 'overrides-docs', "plugins/port/docs/PIPELINE.md carries no '## CLAUDE.md overrides' section");
    for (const literal of [BEGIN, END]) {
      expect(pipelineText.includes(literal), 'overrides-docs', `plugins/port/docs/PIPELINE.md never states the literal marker '${literal}'`);
    }
    const overridableTop = [...new Set(OVERRIDABLE.map((p) => p.split('.')[0]))];
    for (const key of overridableTop) {
      expect(pipelineText.includes(key), 'overrides-docs', `plugins/port/docs/PIPELINE.md's CLAUDE.md overrides section never names the overridable category '${key}'`);
    }
    for (const key of PERMISSION_SURFACE) {
      const named = key === 'commands' ? pipelineText.includes('commands.*') : pipelineText.includes(key);
      expect(named, 'overrides-docs', `plugins/port/docs/PIPELINE.md never names '${key}' as the non-overridable permission surface`);
    }
  }

  // --- /port:init still carries the reconciliation step — must never silently drop, leaving every override undiscovered and undocumented. ---
  {
    const initText = readFileSync(join(root, 'plugins/port/skills/init/SKILL.md'), 'utf8');
    for (const phrase of ['port-overrides', 'Reconcile']) {
      expect(initText.includes(phrase), 'overrides-init', `plugins/port/skills/init/SKILL.md never names '${phrase}' — the import-time reconciliation step`);
    }
  }

  // --- The cockpit reports overrides once at startup and names dispositions in the merge-ready line. ---
  {
    const skillText = pipelineSkillText();
    expect(skillText.includes('overrides'), 'overrides-cockpit', 'plugins/port/skills/pipeline/*.md never mentions CLAUDE.md overrides');
  }

  // --- The parser and resolver each accept a good example and reject a bad one. ---
  {
    const goodText = `<!-- port-overrides:begin -->\n\`\`\`port-overrides\nreviewCycleCap = 3  # we converge in three or it needs a human\n\`\`\`\n<!-- port-overrides:end -->\n`;
    const goodParsed = parseOverrides(goodText);
    expect(!(goodParsed.problems.length !== 0 || goodParsed.entries.length !== 1), 'overrides-selftest', 'parseOverrides rejected a well-formed block');

    const badText = `<!-- port-overrides:begin -->\n\`\`\`port-overrides\nreviewCycleCap = 3\n\`\`\`\n<!-- port-overrides:end -->\n`; // no reason
    const badParsed = parseOverrides(badText);
    expect(!(badParsed.problems.length === 0), 'overrides-selftest', 'parseOverrides accepted a line with no required reason');

    const baseCfg = {
      integration: 'dev',
      production: 'main',
      labels: {},
      models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
      modules: { approvalGate: true, release: true, scope: true },
      reviewCycleCap: 5,
      concurrency: { sharedFiles: [], overlapThreshold: 2 },
      sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
    };
    const permissionResult = applyOverrides(
      baseCfg,
      { entries: [{ path: 'commands.checks', op: '=', rawValue: 'node x.ts', reason: 'refused', line: '' }], problems: [] },
      { labelKeys: [] },
    );
    expect(!(permissionResult.applied.length !== 0), 'overrides-selftest', 'applyOverrides applied an override to commands.checks — the permission surface must never be overridable');
    note(`overrides: ${OVERRIDABLE.length} overridable paths, ${NEVER_OVERRIDABLE.length} never-overridable top-level keys`);
  }
}
