import { readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { root, readJson, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';
import { message } from '../lib/errors.ts';

/** The branch-model coherence rule the schema cannot express: draft 2020-12 has no way to
 *  compare two sibling values. Returns a message, or `null` when coherent. Pure — no I/O. */
export function branchModelError(cfg: any): string | null {
  const integration = cfg.branches?.integration ?? 'dev';
  const hasProduction = Object.hasOwn(cfg.branches ?? {}, 'production');
  const production = hasProduction ? cfg.branches.production : 'main';
  if (production === null) {
    const release = cfg.modules?.release;
    if (release !== false) {
      return `branches.production is null but modules.release is not explicitly false (got ${JSON.stringify(release)})`;
    }
    return null;
  }
  if (production === integration) {
    return `branches.integration and branches.production both resolve to '${integration}'`;
  }
  return null;
}

/** Every whitespace-delimited token ending in `.ts`/`.mjs`/`.js`/`.cjs` with no `<` or `{{`
 *  placeholder. A trailing bare `*` is stripped before extraction, never a reason to skip. */
export function scriptPathsIn(command: string): string[] {
  const inner = command.replace(/^Bash\(/, '').replace(/\)$/, '');
  const tokens = inner.trim().split(/\s+/).filter(Boolean);
  const withoutWildcard = tokens.at(-1) === '*' ? tokens.slice(0, -1) : tokens;
  return withoutWildcard.filter((t) => /\.(ts|mjs|js|cjs)$/.test(t) && !t.includes('<') && !t.includes('{{'));
}

export default async function ({ expect, fail, note, ok }: Reporter) {
  // --- Branch model coherence rail: self-tests branchModelError against a passing and a
  // failing example of each rule before trusting it. ---
  {
    const cases = [
      {
        name: 'null production, explicit release: false',
        cfg: { repo: 'x/y', branches: { integration: 'main', production: null }, modules: { release: false } },
        wantError: false,
      },
      {
        name: 'null production, modules omitted (release defaults true)',
        cfg: { repo: 'x/y', branches: { integration: 'main', production: null } },
        wantError: true,
      },
      {
        name: 'null production, release explicitly true',
        cfg: { repo: 'x/y', branches: { integration: 'main', production: null }, modules: { release: true } },
        wantError: true,
      },
      {
        name: 'distinct integration and production',
        cfg: { repo: 'x/y', branches: { integration: 'dev', production: 'main' } },
        wantError: false,
      },
      {
        name: 'integration equals production explicitly',
        cfg: { repo: 'x/y', branches: { integration: 'main', production: 'main' } },
        wantError: true,
      },
      {
        name: 'integration explicitly main, production omitted (resolves to main too)',
        cfg: { repo: 'x/y', branches: { integration: 'main' } },
        wantError: true,
      },
    ];
    for (const c of cases) {
      const got = branchModelError(c.cfg) !== null;
      expect(!(got !== c.wantError), 'branch-model', `branchModelError self-test failed for '${c.name}': expected error=${c.wantError}, got=${got}`);
    }

    // Run the real predicate over every config-shaped file in the repository.
    const targets = [
      '.claude/port.config.json',
      'plugins/port/templates/port.config.json',
      ...walk(join(root, 'schema/fixtures'))
        .filter((f) => basename(f).startsWith('valid.'))
        .map(relOf),
    ];
    for (const rel of targets) {
      const cfg = readJson(rel);
      const err = branchModelError(cfg);
      expect(!err, 'branch-model', `${rel}: ${err}`);
    }

    // The invalid fixtures built for exactly this rule must still be rejected.
    for (const rel of [
      'schema/fixtures/invalid.release-with-null-production.json',
      'schema/fixtures/invalid.null-production-default-release.json',
    ]) {
      const cfg = readJson(rel);
      expect(!(branchModelError(cfg) === null), 'branch-model', `${rel}: expected branchModelError to reject this fixture, got no error`);
    }

    // The rendered approval-check template must carry no `{{production}}` token.
    const templateRel = 'plugins/port/templates/approval-check.yml';
    expect(!readFileSync(join(root, templateRel), 'utf8').includes('{{production}}'), 'branch-model', `${templateRel} still contains an unresolvable {{production}} token`);

    // Every `{{name}}` placeholder must be named in init/SKILL.md, and the drop-when-absent
    // bullet for {{packageManager}} must also name {{production}}. ---
    const permsText = readFileSync(join(root, 'plugins/port/templates/permissions.base.json'), 'utf8');
    const perms = JSON.parse(permsText);
    const placeholders = new Set(
      [...JSON.stringify([...perms.allow, ...perms.deny]).matchAll(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g)].map((m) => m[1]),
    );
    const skillRel = 'plugins/port/skills/init/SKILL.md';
    const skillText = readFileSync(join(root, skillRel), 'utf8');
    for (const name of placeholders) {
      expect(skillText.includes(`{{${name}}}`), 'branch-model', `${skillRel} never names the '{{${name}}}' placeholder from permissions.base.json`);
    }
    const dropBullet = /^-.*\{\{packageManager\}\}.*drop.*$/m.exec(skillText);
    if (!dropBullet) {
      fail('branch-model', `${skillRel} is missing the bullet stating {{packageManager}}'s drop-when-absent rule`);
    } else expect(dropBullet[0].includes('{{production}}'), 'branch-model', `${skillRel}: the {{packageManager}} drop-rule bullet must also name {{production}}`);

    // PIPELINE.md must state what null production means, and what the CI merge gate covers in single-branch mode.
    const pipelineRel = 'plugins/port/docs/PIPELINE.md';
    const pipelineText = readFileSync(join(root, pipelineRel), 'utf8');
    const productionRow = /\|\s*`<production>`\s*\|[^\n]*\|/.exec(pipelineText);
    expect(!(!productionRow || !productionRow[0].includes('null')), 'branch-model', `${pipelineRel}'s '<production>' table row must name 'null'`);
    const gateSection = /### CI merge gate[\s\S]*?(?=\n## )/.exec(pipelineText);
    expect(!(!gateSection || !gateSection[0].toLowerCase().includes('single-branch')), 'branch-model', `${pipelineRel}'s CI merge gate section must name the single-branch case`);
  }

  // --- Templates are valid JSON: anything downstream reading `undefined` off one that fails to parse. ---
  for (const t of [
    'plugins/port/templates/permissions.base.json',
    'plugins/port/data/labels.json',
    'plugins/port/templates/port.config.json',
    'schema/port.config.schema.json',
    '.claude-plugin/marketplace.json',
    'plugins/port/.claude-plugin/plugin.json',
  ]) {
    try {
      readJson(t);
      ok();
    } catch (e) {
      fail('json', `${t} does not parse: ${message(e)}`);
    }
  }

  // --- This repository's own permissions are non-empty: an empty permissions.allow leaves
  // stage agents on `dontAsk`, auto-denying anything not allowlisted. ---
  {
    const settings = readJson('.claude/settings.json');
    const allow = settings.permissions?.allow;
    expect(!(!Array.isArray(allow) || allow.length === 0), 'permissions', `.claude/settings.json's permissions.allow must be a non-empty array, got ${JSON.stringify(allow)}`);
  }

  // --- The config template matches its own schema's shape: a bare string parses fine while every consumer reading `entry.run` gets undefined. ---
  {
    const cfg = readJson('plugins/port/templates/port.config.json');
    for (const entry of cfg.commands?.checks ?? []) {
      if (typeof entry !== 'object' || entry === null || typeof entry.run !== 'string') {
        fail('config-template', `commands.checks entries must be objects with a 'run' string, got ${JSON.stringify(entry)}`);
      }
    }
    for (const entry of cfg.commands?.bootstrap ?? []) {
      if (typeof entry !== 'string') {
        fail('config-template', `commands.bootstrap entries must be strings, got ${JSON.stringify(entry)}`);
      }
    }
    ok();
  }

  // --- Schema fixtures still discriminate: a fixture set proving only acceptance proves
  // nothing. Needs a real validator; reported as skipped, never silently passing. ---
  {
    const fixtures = walk(join(root, 'schema/fixtures')).filter((f) => f.endsWith('.json'));
    const valid = fixtures.filter((f) => basename(f).startsWith('valid.'));
    const invalid = fixtures.filter((f) => basename(f).startsWith('invalid.'));
    if (valid.length === 0 || invalid.length === 0) {
      fail('fixtures', 'expected both valid.* and invalid.* fixtures');
    }
    for (const f of fixtures) {
      try {
        JSON.parse(readFileSync(f, 'utf8'));
      } catch (e) {
        fail('fixtures', `${basename(f)} does not parse: ${message(e)}`);
      }
    }
    note(
      `fixtures: ${valid.length} valid, ${invalid.length} invalid — parse-checked only; run a draft 2020-12 validator for full coverage (see schema/README.md)`,
    );
    ok();
  }

  // --- No previewDatabase survives — a deleted config flag's name, never swept. This
  // check's own message is the one place the literal may still appear, so the walk excludes scripts/. ---
  {
    const scanDirs = ['plugins', 'schema', 'apps/desktop/src', 'evals', '.github'];
    const hits = [];
    for (const dir of scanDirs) {
      for (const f of walk(join(root, dir))) {
        const text = readFileSync(f, 'utf8');
        if (text.includes('previewDatabase')) hits.push(relOf(f));
      }
    }
    const cfg = readJson('.claude/port.config.json');
    if ('previewDatabase' in (cfg.modules ?? {})) hits.push('.claude/port.config.json');
    expect(!(hits.length > 0), 'no-preview-database', `'previewDatabase' still appears outside scripts/: ${hits.join(', ')}`);
  }

  // --- Every script path this repository configures resolves on disk: this repository's own
  // two config files, never a template or fixture (an adopter's own path is theirs alone). ---
  {
    const selfTestCases: [string, string[]][] = [
      ['pnpm install', []],
      ['node scripts/checks.ts', ['scripts/checks.ts']],
      ['node scripts/checks.ts --verbose', ['scripts/checks.ts']],
      ['Bash(node scripts/checks.ts *)', ['scripts/checks.ts']],
      ['node scripts/checks-<topic>.ts', []],
    ];
    for (const [command, expected] of selfTestCases) {
      const got = scriptPathsIn(command);
      expect(!(JSON.stringify(got) !== JSON.stringify(expected)), 'config-script-paths-selftest', `scriptPathsIn(${JSON.stringify(command)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
    }

    const cfg = readJson('.claude/port.config.json');
    const settings = readJson('.claude/settings.json');
    const commandSources: string[] = [
      ...(cfg.commands?.bootstrap ?? []),
      ...(cfg.commands?.checks ?? []).flatMap((e: any) => [e.run, e.fix]),
      cfg.commands?.artifacts,
      cfg.commands?.worktrees,
      cfg.commands?.budget,
      cfg.commands?.tick,
      cfg.release?.postPublishHook,
      ...(cfg.extraAllow ?? []),
      ...(settings.permissions?.allow ?? []),
    ].filter((c) => typeof c === 'string');

    let anyPath = false;
    for (const command of commandSources) {
      for (const p of scriptPathsIn(command)) {
        anyPath = true;
        expect(existsSync(join(root, p)), 'config-script-paths', `'${command}' names '${p}', which does not exist on disk`);
      }
    }
    if (!anyPath) {
      fail('config-script-paths', 'no script path resolved at all across commands.*, extraAllow, and permissions.allow — the extractor may be broken');
    }

    const pkg = readJson('package.json');
    expect(!(pkg.type !== 'module'), 'config-script-paths', `package.json's 'type' is ${JSON.stringify(pkg.type)}, not 'module' — every scripts/*.ts file loads as ESM only because of this field`);
  }
}
