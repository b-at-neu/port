import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { root, readJson, walk } from '../lib/files.mjs';

export default async function ({ fail, note, ok }) {
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
