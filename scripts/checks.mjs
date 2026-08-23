#!/usr/bin/env node
// Layer 1 of the testing loop: deterministic checks over the plugin's files.
//
// No model calls, no dependencies, and no plugin install required — a
// dispatched agent's worktree may not resolve the plugin, so every check here
// works from files alone.
//
// Each check exists because something actually broke. The failure mode these
// guard against is silence: a malformed component is *absent* from Claude
// Code's inventory rather than reported as an error, so nothing complains.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const notes = [];
let checked = 0;

const fail = (check, detail) => failures.push(`${check}: ${detail}`);
const ok = () => checked++;

const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
const walk = (dir) =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((e) => {
        const p = join(dir, e);
        return statSync(p).isDirectory() ? walk(p) : [p];
      })
    : [];

/** Frontmatter key/value pairs. Deliberately not a YAML parser — presence and
 *  scalar shape is all these checks need, and a dependency is not worth it. */
function frontmatter(file) {
  const text = readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

// --- Components parse and declare what they must ---------------------------
// A skill or agent whose frontmatter is malformed is silently missing from the
// component inventory. Nothing errors; it simply is not there.
for (const [dir, kind] of [
  ['plugins/port/agents', 'agent'],
  ['plugins/port/skills', 'skill'],
]) {
  const files = walk(join(root, dir)).filter((f) =>
    kind === 'agent' ? f.endsWith('.md') : basename(f) === 'SKILL.md',
  );
  if (files.length === 0) fail('components', `no ${kind}s found under ${dir}`);
  for (const f of files) {
    const rel = f.slice(root.length + 1);
    const fm = frontmatter(f);
    if (!fm) {
      fail('frontmatter', `${rel} has no --- delimited frontmatter`);
      continue;
    }
    for (const key of ['name', 'description']) {
      if (!fm[key]) fail('frontmatter', `${rel} is missing '${key}'`);
    }
    const expected =
      kind === 'agent' ? basename(f, '.md') : basename(dirname(f));
    if (fm.name && fm.name !== expected) {
      fail('frontmatter', `${rel} declares name '${fm.name}', expected '${expected}'`);
    }
    ok();
  }
}

// --- hooks.json command shape ----------------------------------------------
// Regression test for the argv-array form, which loaded as Hooks (0): no
// error, no warning, the hook simply absent.
{
  const hooks = readJson('plugins/port/hooks/hooks.json');
  const entries = Object.values(hooks.hooks ?? {}).flat();
  if (entries.length === 0) fail('hooks', 'hooks.json declares no hooks');
  for (const matcher of entries) {
    for (const h of matcher.hooks ?? []) {
      if (typeof h.command !== 'string') {
        fail(
          'hooks',
          `command must be a shell string, got ${Array.isArray(h.command) ? 'an array' : typeof h.command}`,
        );
      }
      ok();
    }
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
  notes.push(
    `fixtures: ${valid.length} valid, ${invalid.length} invalid — parse-checked only; run a draft 2020-12 validator for full coverage (see schema/README.md)`,
  );
  ok();
}

// --- Stale references -------------------------------------------------------
// Each of these named something real that was renamed or moved.
{
  const docs = [
    ...walk(join(root, 'plugins')),
    ...walk(join(root, 'docs')),
    ...walk(join(root, 'schema')),
    join(root, 'README.md'),
    join(root, 'CONTRIBUTING.md'),
  ].filter((f) => f.endsWith('.md') && existsSync(f));

  const banned = [
    [/\bport-init\b/, 'the installer skill is `init`, invoked as /port:init'],
    [
      /`port\.config\.json`/,
      'the config lives at `.claude/port.config.json`',
      // /port:init's migration step names the legacy root location on purpose —
      // it is the one place that acts on it. Any other bare mention is stale.
      (line) => line.includes('repository root'),
    ],
    [/(^|[^:\w/])\/(pipeline|scope|implement|release|worktree-clean|analyze|init)\b/, 'skill references need the `port:` prefix'],
  ];
  for (const f of docs) {
    const rel = f.slice(root.length + 1);
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      for (const [re, why, exempt] of banned) {
        const m = re.exec(line);
        if (m && !(exempt && exempt(line))) {
          fail('stale-reference', `${rel}: ${why} (found ${JSON.stringify(m[0].trim())})`);
        }
      }
    }
  }
  ok();
}

// --- Report -----------------------------------------------------------------
for (const n of notes) console.log(`note  ${n}`);
if (failures.length === 0) {
  console.log(`ok    ${checked} checks passed`);
  process.exit(0);
}
for (const f of failures) console.error(`FAIL  ${f}`);
console.error(`\n${failures.length} failure(s), ${checked} checks run`);
process.exit(1);
