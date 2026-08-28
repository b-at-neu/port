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
import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReporter } from './lib/report.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { fail, note, ok, report } = createReporter();

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

// --- Denial hook is registered on PermissionDenied, and nothing else -------
// Regression guard for #63: the hook now records the harness's actual
// decision, which only the PermissionDenied event carries. Registering it
// under PreToolUse (or anything else) silently reintroduces prediction.
{
  const hooks = readJson('plugins/port/hooks/hooks.json').hooks ?? {};
  const isDenialHook = (h) =>
    typeof h.command === 'string' && h.command.includes('log-bash-denial.mjs');
  let registeredOnPermissionDenied = false;
  for (const [event, matchers] of Object.entries(hooks)) {
    for (const matcher of matchers) {
      for (const h of matcher.hooks ?? []) {
        if (!isDenialHook(h)) continue;
        if (event === 'PermissionDenied') registeredOnPermissionDenied = true;
        else fail('denial-hook', `log-bash-denial.mjs is registered under '${event}', expected 'PermissionDenied'`);
      }
    }
  }
  if (!registeredOnPermissionDenied) fail('denial-hook', 'log-bash-denial.mjs is not registered under PermissionDenied');
  ok();
}

// --- Denial hook payload handling -------------------------------------------
// Spawns the real hook script against representative PermissionDenied
// payloads. The fixture directory must sit outside any git repository, or
// `git rev-parse --git-common-dir` resolves to this checkout and the fixture
// appends to the operator's own `.agents/denials.log`.
{
  const hookPath = join(root, 'plugins/port/hooks/log-bash-denial.mjs');
  const fixture = mkdtempSync(join(tmpdir(), 'port-denial-hook-'));
  try {
    mkdirSync(join(fixture, '.claude'), { recursive: true });
    writeFileSync(join(fixture, '.claude', 'port.config.json'), '{}');

    const run = (payload) => {
      execFileSync(process.execPath, [hookPath], {
        cwd: fixture,
        input: JSON.stringify(payload),
        stdio: ['pipe', 'ignore', 'ignore'],
      });
    };
    const readLog = () => {
      const p = join(fixture, '.agents', 'denials.log');
      return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean) : [];
    };

    // Subagent denial → agent: actor.
    run({
      cwd: fixture,
      session_id: 'sess-1',
      permission_mode: 'dontAsk',
      agent_id: 'agent-1',
      agent_type: 'impl-agent',
      reason: 'not in allowlist',
      tool_input: { command: 'rm -rf /' },
    });
    let lines = readLog();
    if (lines.length !== 1) fail('denial-hook-fixture', `expected 1 line after a subagent denial, got ${lines.length}`);
    else if (lines[0].split('\t').length !== 5) fail('denial-hook-fixture', `expected 5 tab-separated fields, got ${JSON.stringify(lines[0])}`);
    else if (!lines[0].includes('\tagent:impl-agent:agent-1\t')) fail('denial-hook-fixture', `expected an agent: actor, got ${JSON.stringify(lines[0])}`);
    ok();

    // Main-thread denial → session: actor.
    run({
      cwd: fixture,
      session_id: 'sess-2',
      permission_mode: 'default',
      reason: 'not in allowlist',
      tool_input: { command: 'gh pr merge 1' },
    });
    lines = readLog();
    if (lines.length !== 2) fail('denial-hook-fixture', `expected 2 lines after a main-thread denial, got ${lines.length}`);
    else if (!lines[1].includes('\tsession:sess-2\t')) fail('denial-hook-fixture', `expected a session: actor, got ${JSON.stringify(lines[1])}`);
    ok();

    // No port.config.json in cwd → nothing written.
    const unmanaged = mkdtempSync(join(tmpdir(), 'port-denial-hook-unmanaged-'));
    try {
      execFileSync(process.execPath, [hookPath], {
        cwd: unmanaged,
        input: JSON.stringify({ cwd: unmanaged, session_id: 'sess-3', tool_input: { command: 'rm -rf /' } }),
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      if (existsSync(join(unmanaged, '.agents', 'denials.log'))) {
        fail('denial-hook-fixture', 'wrote a log file outside a port-managed repository');
      }
      ok();
    } finally {
      rmSync(unmanaged, { recursive: true, force: true });
    }

    // Malformed payload → exits 0, nothing written.
    execFileSync(process.execPath, [hookPath], {
      cwd: fixture,
      input: 'not json',
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    if (readLog().length !== 2) fail('denial-hook-fixture', 'a malformed payload should not append a line');
    ok();
  } catch (e) {
    if (e.status !== undefined) fail('denial-hook-fixture', `hook exited non-zero: ${e.message}`);
    else throw e;
  } finally {
    rmSync(fixture, { recursive: true, force: true });
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

// --- Self-hosted marketplace entry stays pinned -----------------------------
// A bare `claude plugin marketplace add` rewrites this entry back to its
// unpinned form, which tracks the default branch instead of a release and
// silently reintroduces the drift #119 fixed.
{
  const settings = readJson('.claude/settings.json');
  const port = settings.extraKnownMarketplaces?.port;
  if (port?.source?.ref !== 'main') {
    fail('marketplace', `extraKnownMarketplaces.port.source.ref must be 'main', got ${JSON.stringify(port?.source?.ref)}`);
  }
  if (port?.autoUpdate !== true) {
    fail('marketplace', `extraKnownMarketplaces.port.autoUpdate must be true, got ${JSON.stringify(port?.autoUpdate)}`);
  }
  ok();
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

// --- Stale references -------------------------------------------------------
// Each of these named something real that was renamed or moved.
{
  const docs = [
    ...walk(join(root, 'plugins')),
    ...walk(join(root, 'docs')),
    ...walk(join(root, 'schema')),
    ...walk(join(root, 'evals')),
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

// --- Eval cases are structurally sound --------------------------------------
// Everything statically knowable about a layer 3 case is checked here, for free,
// so a broken case is caught without an API key or early access. Presence and
// shape only, by regex — same reasoning as the frontmatter reader above.
{
  const caseFiles = walk(join(root, 'evals')).filter((f) => basename(f) === 'case.yaml');
  if (caseFiles.length === 0) {
    fail('evals', 'no evals/*/case.yaml found — layer 3 cases exist as files even before they can run');
  }

  const referenced = new Set();
  for (const f of caseFiles) {
    const rel = f.slice(root.length + 1);
    const text = readFileSync(f, 'utf8');
    for (const key of ['name', 'prompt', 'graders']) {
      if (!new RegExp(`^${key}:`, 'm').test(text)) {
        fail('evals', `${rel} is missing '${key}'`);
      }
    }
    // `graders:` is a block list — take the `- item` lines that follow it.
    const block = /^graders:[^\n]*\n((?:[ \t]+-[^\n]*\n?)*)/m.exec(text);
    const named = [...(block?.[1] ?? '').matchAll(/^[ \t]+-\s*(.+?)\s*$/gm)].map((m) => m[1]);
    if (block && named.length === 0) {
      fail('evals', `${rel} declares 'graders' but names none`);
    }
    for (const g of named) {
      referenced.add(g);
      if (!existsSync(join(root, 'evals/graders', g))) {
        fail('evals', `${rel} references grader '${g}', which is not a file under evals/graders/`);
      }
    }
    ok();
  }

  for (const g of walk(join(root, 'evals/graders')).filter((f) => f.endsWith('.md'))) {
    if (!referenced.has(basename(g))) {
      fail('evals', `evals/graders/${basename(g)} is referenced by no case`);
    }
  }
  ok();
}

// --- Behavioural evals never enter commands.checks --------------------------
// The mechanical form of the ticket's own last rule. `commands.checks` is what
// impl-agent runs before pushing, so an eval or an audit there means every
// dispatched agent spawning model runs, or shelling out to `gh` it cannot reach.
{
  const banned = [
    [/plugin\s+eval/, 'a behavioural eval'],
    [/scripts\/artifacts\.mjs/, 'the layer 2 artifact audit'],
  ];
  for (const rel of ['.claude/port.config.json', 'plugins/port/templates/port.config.json']) {
    if (!existsSync(join(root, rel))) continue;
    for (const entry of readJson(rel).commands?.checks ?? []) {
      for (const cmd of [entry?.run, entry?.fix]) {
        if (typeof cmd !== 'string') continue;
        for (const [re, what] of banned) {
          if (re.test(cmd)) {
            fail('checks-scope', `${rel} runs ${what} from commands.checks (${JSON.stringify(cmd)})`);
          }
        }
      }
    }
    ok();
  }
}

// --- Report -----------------------------------------------------------------
report();
