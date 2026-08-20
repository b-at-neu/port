// PreToolUse hook (matcher: Bash) for the port agent pipeline.
//
// Logs every Bash command NOT on the repository's permission allowlist to
// `.agents/denials.log` in the base repository, so the cockpit can surface
// clustered denials without interrupting the operator. Logging only: it always
// exits 0 and never blocks. The actual denying is done by the stage agents'
// `permissionMode: dontAsk`.
//
// Two invariants worth stating, because both are easy to break:
//
//  1. It no-ops unless the repository has a `port.config.json`. A plugin's
//     hooks fire in EVERY session once installed at user scope, regardless of
//     working directory, so without this guard installing port would start
//     writing logs into unrelated projects.
//
//  2. The allowlist is derived from the repository's own settings at runtime
//     rather than duplicated here. A hardcoded copy is a second source of
//     truth that silently drifts from the one being enforced.
import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Nearest ancestor of `from` containing `rel`, or null. */
function findUp(from, rel) {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, rel))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Base repository root, so every worktree logs to one file. */
function baseRepoRoot(cwd) {
  try {
    const common = execSync('git rev-parse --git-common-dir', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return resolve(cwd, common, '..');
  } catch {
    return cwd;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * `Bash(...)` allow patterns → anchored regexes.
 *
 * Claude Code matches these against the command string with `*` as the only
 * wildcard, so every other regex metacharacter is escaped. `Bash(grep)` and
 * `Bash(grep *)` are distinct entries covering the bare and argument forms;
 * deriving both from settings keeps this faithful to what is enforced.
 */
function allowMatchers(settingsFiles) {
  const patterns = new Set();
  for (const file of settingsFiles) {
    const allow = readJson(file)?.permissions?.allow;
    if (!Array.isArray(allow)) continue;
    for (const entry of allow) {
      if (typeof entry !== 'string') continue;
      const m = /^Bash\((.*)\)$/.exec(entry.trim());
      if (m) patterns.add(m[1]);
    }
  }
  return [...patterns].map((p) => {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^' + escaped.replace(/\\\*/g, '.*') + '$');
  });
}

try {
  const data = JSON.parse(readFileSync(0, 'utf8')); // PreToolUse JSON on stdin
  const command = (data?.tool_input?.command ?? '').trim();
  if (!command) process.exit(0);

  const cwd = data?.cwd ?? process.cwd();

  // Invariant 1: silent outside a port-managed repository.
  const configRoot = findUp(cwd, 'port.config.json');
  if (!configRoot) process.exit(0);

  // Invariant 2: matchers come from the settings actually in effect. A
  // worktree carries the committed settings, so resolve from cwd upward.
  const settingsRoot = findUp(cwd, join('.claude', 'settings.json')) ?? configRoot;
  const matchers = allowMatchers([
    join(settingsRoot, '.claude', 'settings.json'),
    join(settingsRoot, '.claude', 'settings.local.json'),
  ]);

  // No parseable allowlist means nothing can be classified as denied.
  if (matchers.length === 0) process.exit(0);
  if (matchers.some((re) => re.test(command))) process.exit(0);

  const dir = join(baseRepoRoot(cwd), '.agents');
  mkdirSync(dir, { recursive: true });
  const who = data?.agent ?? data?.subagent_type ?? data?.session_id ?? 'unknown';
  appendFileSync(
    join(dir, 'denials.log'),
    `${new Date().toISOString()}\t${who}\t${command.replace(/\s+/g, ' ').slice(0, 500)}\n`,
  );
} catch {
  // Never block or fail the tool call.
}
process.exit(0);
