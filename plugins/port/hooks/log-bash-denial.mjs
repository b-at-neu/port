// PermissionDenied hook (matcher: Bash) for the port agent pipeline.
//
// Records every Bash command the harness actually denied to
// `.agents/denials.log` in the base repository, so the cockpit can surface
// clustered denials without interrupting the operator. Logging only: it
// always exits 0, never blocks, and never writes to stdout — stdout is
// parsed as hook output, and a JSON reply here would tell the model to retry
// the call.
//
// It no-ops unless the repository has a `.claude/port.config.json`. A
// plugin's hooks fire in EVERY session once installed at user scope,
// regardless of working directory, so without this guard installing port
// would start writing logs into unrelated projects.
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

/** Whitespace-collapsed and length-capped, so a value can never break the
 *  positional tab-separated format or grow unbounded. */
function field(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

try {
  const data = JSON.parse(readFileSync(0, 'utf8')); // PermissionDenied JSON on stdin
  const command = data?.tool_input?.command;
  if (!command) process.exit(0);

  const cwd = data?.cwd ?? process.cwd();

  // Silent outside a port-managed repository.
  const configRoot = findUp(cwd, join('.claude', 'port.config.json'));
  if (!configRoot) process.exit(0);

  // `agent_id` is present only inside a dispatched subagent; the main thread
  // (cockpit, /port:implement, or an ordinary interactive session) has none,
  // and always shares a subagent's own session_id with its parent otherwise.
  const actor = data?.agent_id
    ? `agent:${data?.agent_type ?? 'unknown'}:${data.agent_id}`
    : `session:${data?.session_id ?? 'unknown'}`;
  const mode = data?.permission_mode ?? 'mode?';

  const dir = join(baseRepoRoot(cwd), '.agents');
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, 'denials.log'),
    [
      new Date().toISOString(),
      actor,
      mode,
      field(data?.reason, 200),
      field(command, 500),
    ].join('\t') + '\n',
  );
} catch {
  // Never block or fail the tool call.
}
process.exit(0);
