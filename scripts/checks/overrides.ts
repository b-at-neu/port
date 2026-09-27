import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson, pipelineSkillText } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

const ENGINE_REL = 'scripts/port-tick/overrides.ts';

export default async function ({ fail, note, ok }: Reporter) {
  const engine: any = await import(pathToFileURL(join(root, ENGINE_REL)).href);
  const OVERRIDABLE: string[] = engine.OVERRIDABLE;
  const NEVER_OVERRIDABLE: string[] = engine.NEVER_OVERRIDABLE;
  const PERMISSION_SURFACE: Set<string> = engine.PERMISSION_SURFACE;
  const { parseOverrides, applyOverrides, BEGIN, END } = engine;

  // --- OVERRIDABLE ∪ NEVER_OVERRIDABLE covers every schema top-level key,
  // both directions (#246)
  // guard(#246): a schema key added later never classified as overridable or
  // refused, silently falling through `overrides.ts`'s own default-refusal
  // path with nothing here to catch the omission. `checks` is the one
  // synthetic entry allowed on the overridable side — no `port.config.json`
  // field backs it, since it is the first consumer of this general
  // mechanism rather than a schema-derived category.
  {
    const schema = readJson('schema/port.config.schema.json');
    const schemaKeys = new Set(Object.keys(schema.properties ?? {}));

    const overridableTop = new Set(OVERRIDABLE.map((p) => p.split('.')[0]));
    const neverTop = new Set(NEVER_OVERRIDABLE);

    for (const key of overridableTop) {
      if (key === 'checks') continue; // synthetic — asserted separately below
      if (!schemaKeys.has(key)) fail('overrides-schema', `${ENGINE_REL}'s OVERRIDABLE names top-level category '${key}', which the schema does not carry`);
      else ok();
    }
    for (const key of neverTop) {
      if (!schemaKeys.has(key)) fail('overrides-schema', `${ENGINE_REL}'s NEVER_OVERRIDABLE names '${key}', which the schema does not carry`);
      else ok();
    }
    for (const key of schemaKeys) {
      if (key === '$schema') continue; // meta pointer, not a config category
      if (!overridableTop.has(key) && !neverTop.has(key)) {
        fail('overrides-schema', `schema top-level key '${key}' is classified as neither overridable nor never-overridable in ${ENGINE_REL} — a key added later must be classified explicitly`);
      } else {
        ok();
      }
    }

    // 'checks' is synthetic and must never also collide with a real schema key.
    if (schemaKeys.has('checks')) {
      fail('overrides-schema', `the schema now carries a real 'checks' top-level key, which collides with the synthetic override category of the same name`);
    } else {
      ok();
    }

    // The permission surface is refused by name, and is a subset of NEVER_OVERRIDABLE.
    for (const key of PERMISSION_SURFACE) {
      if (!neverTop.has(key)) fail('overrides-schema', `PERMISSION_SURFACE names '${key}', which NEVER_OVERRIDABLE does not carry`);
      else ok();
    }
  }

  // --- labels.<key> resolves against data/labels.json --------------------------
  // guard(#246): an override naming a label key that does not exist in the
  // vocabulary at all, applied anyway because nothing checked it against the
  // real key set.
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
    if (goodResult.refused.length !== 0 || goodResult.applied.length !== 1) {
      fail('overrides-labels', `applyOverrides refused a labels.${realKey} override naming a real label key`);
    } else {
      ok();
    }

    const badEntry = { path: 'labels.notARealKey', op: '=' as const, rawValue: 'x', reason: 'typo', line: '' };
    const badResult = applyOverrides(baseCfg, { entries: [badEntry], problems: [] }, { labelKeys });
    if (badResult.applied.length !== 0 || badResult.refused.length !== 1) {
      fail('overrides-labels', 'applyOverrides applied labels.notARealKey — the label key set was never checked');
    } else {
      ok();
    }
  }

  // --- PIPELINE.md's category table matches OVERRIDABLE, and the marker
  // literals agree with the parser's own (#246)
  // guard(#246): the shipped documentation drifting from the parser it
  // describes — an operator writes a block that follows the doc and the
  // engine silently refuses every line, or vice versa.
  // pin: `plugins/port/docs/PIPELINE.md`'s "CLAUDE.md overrides" category table ↔ `scripts/port-tick/overrides.ts`'s `OVERRIDABLE`/`NEVER_OVERRIDABLE`/`BEGIN`/`END`
  {
    const pipelineText = readFileSync(join(root, 'plugins/port/docs/PIPELINE.md'), 'utf8');
    if (!pipelineText.includes('## CLAUDE.md overrides')) {
      fail('overrides-docs', "plugins/port/docs/PIPELINE.md carries no '## CLAUDE.md overrides' section");
    } else {
      ok();
    }
    for (const literal of [BEGIN, END]) {
      if (!pipelineText.includes(literal)) {
        fail('overrides-docs', `plugins/port/docs/PIPELINE.md never states the literal marker '${literal}'`);
      } else {
        ok();
      }
    }
    const overridableTop = [...new Set(OVERRIDABLE.map((p) => p.split('.')[0]))];
    for (const key of overridableTop) {
      if (!pipelineText.includes(key)) {
        fail('overrides-docs', `plugins/port/docs/PIPELINE.md's CLAUDE.md overrides section never names the overridable category '${key}'`);
      } else {
        ok();
      }
    }
    for (const key of PERMISSION_SURFACE) {
      const named = key === 'commands' ? pipelineText.includes('commands.*') : pipelineText.includes(key);
      if (!named) {
        fail('overrides-docs', `plugins/port/docs/PIPELINE.md never names '${key}' as the non-overridable permission surface`);
      } else {
        ok();
      }
    }
  }

  // --- /port:init still carries the reconciliation step (#246) ---------------
  // guard(#246): the import-time reconciliation flow silently dropped from
  // the installer, leaving every override undiscovered and undocumented —
  // exactly the negotiated-in-prose failure mode this ticket forbids.
  {
    const initText = readFileSync(join(root, 'plugins/port/skills/init/SKILL.md'), 'utf8');
    for (const phrase of ['port-overrides', 'Reconcile']) {
      if (!initText.includes(phrase)) {
        fail('overrides-init', `plugins/port/skills/init/SKILL.md never names '${phrase}' — the import-time reconciliation step`);
      } else {
        ok();
      }
    }
  }

  // --- The cockpit reports overrides once at startup and names dispositions
  // in the merge-ready line (#246)
  {
    const skillText = pipelineSkillText();
    if (!skillText.includes('overrides')) {
      fail('overrides-cockpit', 'plugins/port/skills/pipeline/*.md never mentions CLAUDE.md overrides');
    } else {
      ok();
    }
  }

  // --- A check that cannot be made to fail is not a check: the parser and
  // resolver each accept a good example and reject a bad one (#246)
  {
    const goodText = `<!-- port-overrides:begin -->\n\`\`\`port-overrides\nreviewCycleCap = 3  # we converge in three or it needs a human\n\`\`\`\n<!-- port-overrides:end -->\n`;
    const goodParsed = parseOverrides(goodText);
    if (goodParsed.problems.length !== 0 || goodParsed.entries.length !== 1) {
      fail('overrides-selftest', 'parseOverrides rejected a well-formed block');
    } else {
      ok();
    }

    const badText = `<!-- port-overrides:begin -->\n\`\`\`port-overrides\nreviewCycleCap = 3\n\`\`\`\n<!-- port-overrides:end -->\n`; // no reason
    const badParsed = parseOverrides(badText);
    if (badParsed.problems.length === 0) {
      fail('overrides-selftest', 'parseOverrides accepted a line with no required reason');
    } else {
      ok();
    }

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
    if (permissionResult.applied.length !== 0) {
      fail('overrides-selftest', 'applyOverrides applied an override to commands.checks — the permission surface must never be overridable');
    } else {
      ok();
    }
    note(`overrides: ${OVERRIDABLE.length} overridable paths, ${NEVER_OVERRIDABLE.length} never-overridable top-level keys`);
  }
}
