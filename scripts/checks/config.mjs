import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { root, readJson, walk, relOf } from '../lib/files.mjs';

/** The branch-model coherence rule the schema cannot express (#54): draft
 *  2020-12 has no way to compare two sibling values, so a null `production`
 *  paired with `modules.release` defaulting true, and a `production` that
 *  resolves to the same name as `integration`, are both caught here rather
 *  than in the schema. Returns a message describing the problem, or `null`
 *  when the config is coherent. Pure — no I/O — so it is unit-testable
 *  inline and reusable against every config-shaped file in the repository. */
export function branchModelError(cfg) {
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

export default async function ({ fail, note, ok }) {
  // --- Branch model coherence rail (#54) --------------------------------------
  // A check that cannot be made to fail is not a check: self-test branchModelError
  // against a passing and a failing example of each rule before trusting it.
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
      if (got !== c.wantError) {
        fail('branch-model', `branchModelError self-test failed for '${c.name}': expected error=${c.wantError}, got=${got}`);
      } else {
        ok();
      }
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
      if (err) fail('branch-model', `${rel}: ${err}`);
      else ok();
    }

    // The invalid fixtures built for exactly this rule must still be rejected.
    for (const rel of [
      'schema/fixtures/invalid.release-with-null-production.json',
      'schema/fixtures/invalid.null-production-default-release.json',
    ]) {
      const cfg = readJson(rel);
      if (branchModelError(cfg) === null) {
        fail('branch-model', `${rel}: expected branchModelError to reject this fixture, got no error`);
      } else {
        ok();
      }
    }

    // The rendered approval-check template must carry no `{{production}}` token —
    // a placeholder a single-branch install could never fill.
    const templateRel = 'plugins/port/templates/approval-check.yml';
    if (readFileSync(join(root, templateRel), 'utf8').includes('{{production}}')) {
      fail('branch-model', `${templateRel} still contains an unresolvable {{production}} token`);
    } else {
      ok();
    }

    // Every `{{name}}` placeholder in permissions.base.json's allow/deny must be
    // named somewhere in init/SKILL.md, and the bullet that carries
    // {{packageManager}}'s drop-when-absent rule must also name {{production}} —
    // regression guard for the same drop rule silently applying to only one of
    // the two placeholders that can be absent.
    const permsText = readFileSync(join(root, 'plugins/port/templates/permissions.base.json'), 'utf8');
    const perms = JSON.parse(permsText);
    const placeholders = new Set(
      [...JSON.stringify([...perms.allow, ...perms.deny]).matchAll(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g)].map((m) => m[1]),
    );
    const skillRel = 'plugins/port/skills/init/SKILL.md';
    const skillText = readFileSync(join(root, skillRel), 'utf8');
    for (const name of placeholders) {
      if (!skillText.includes(`{{${name}}}`)) {
        fail('branch-model', `${skillRel} never names the '{{${name}}}' placeholder from permissions.base.json`);
      } else {
        ok();
      }
    }
    const dropBullet = /^-.*\{\{packageManager\}\}.*drop.*$/m.exec(skillText);
    if (!dropBullet) {
      fail('branch-model', `${skillRel} is missing the bullet stating {{packageManager}}'s drop-when-absent rule`);
    } else if (!dropBullet[0].includes('{{production}}')) {
      fail('branch-model', `${skillRel}: the {{packageManager}} drop-rule bullet must also name {{production}}`);
    } else {
      ok();
    }

    // PIPELINE.md must state what null production means, and what the CI merge
    // gate covers in single-branch mode.
    const pipelineRel = 'plugins/port/docs/PIPELINE.md';
    const pipelineText = readFileSync(join(root, pipelineRel), 'utf8');
    const productionRow = /\|\s*`<production>`\s*\|[^\n]*\|/.exec(pipelineText);
    if (!productionRow || !productionRow[0].includes('null')) {
      fail('branch-model', `${pipelineRel}'s '<production>' table row must name 'null'`);
    } else {
      ok();
    }
    const gateSection = /### CI merge gate[\s\S]*?(?=\n## )/.exec(pipelineText);
    if (!gateSection || !gateSection[0].toLowerCase().includes('single-branch')) {
      fail('branch-model', `${pipelineRel}'s CI merge gate section must name the single-branch case`);
    } else {
      ok();
    }
  }

  // --- Templates are valid JSON ----------------------------------------------
  for (const t of [
    'plugins/port/templates/permissions.base.json',
    'plugins/port/templates/labels.json',
    'plugins/port/templates/port.config.json',
    'schema/port.config.schema.json',
    '.claude-plugin/marketplace.json',
    'plugins/port/.claude-plugin/plugin.json',
  ]) {
    try {
      readJson(t);
      ok();
    } catch (e) {
      fail('json', `${t} does not parse: ${e.message}`);
    }
  }

  // --- This repository's own permissions are non-empty -----------------------
  // This is the exact condition the cockpit's startup preflight checks at
  // runtime: a repository with `.claude/settings.json` present but
  // `permissions.allow` missing or empty left the pilot repository with no
  // permission rules at all, fully silently — stage agents run `dontAsk` and
  // auto-deny anything not allowlisted.
  {
    const settings = readJson('.claude/settings.json');
    const allow = settings.permissions?.allow;
    if (!Array.isArray(allow) || allow.length === 0) {
      fail('permissions', `.claude/settings.json's permissions.allow must be a non-empty array, got ${JSON.stringify(allow)}`);
    } else {
      ok();
    }
  }

  // --- The config template matches its own schema's shape --------------------
  // Regression test for checks written as bare strings: still valid JSON, still
  // plausible-looking, and every consumer reading `entry.run` gets undefined.
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

  // --- Schema fixtures still discriminate ------------------------------------
  // Needs a real validator. Reported as skipped rather than silently passing,
  // because a check that quietly does nothing is worse than one that is absent.
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
        fail('fixtures', `${basename(f)} does not parse: ${e.message}`);
      }
    }
    note(
      `fixtures: ${valid.length} valid, ${invalid.length} invalid — parse-checked only; run a draft 2020-12 validator for full coverage (see schema/README.md)`,
    );
    ok();
  }

  // --- CI workflow names every platform in its matrix -------------------------
  // Regression guard: quietly dropping `windows-latest` after a red run would
  // look like a tidy-up in review, and nothing else would notice the platform
  // stopped being tested.
  {
    const rel = '.github/workflows/checks.yml';
    const text = readFileSync(join(root, rel), 'utf8');
    for (const label of ['ubuntu-latest', 'macos-latest', 'windows-latest']) {
      if (!text.includes(label)) {
        fail('platform-matrix', `${rel} never names the runner label '${label}'`);
      } else {
        ok();
      }
    }
  }
}
