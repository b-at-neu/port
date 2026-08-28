// PreToolUse hook (matchers: Bash, Edit|Write|NotebookEdit) for the port
// agent pipeline.
//
// This is the component that actually denies. It decides, for every Bash
// call and every write-tool call, whether the caller is a dispatched
// subagent and whether the call misses the repository's allowlist (Bash) or
// targets a `sessionRequiredPaths` path (writes) — and when both are true it
// returns an explicit `permissionDecision: "deny"`, so no permission dialog
// ever reaches the operator regardless of the parent session's mode.
// `permissionMode: dontAsk` on the stage agents is a second line of defence,
// not the mechanism this relies on.
//
// Every decision — deny, a same-shape miss from a non-subagent session, or
// an internal failure — is logged to a gitignored `.agents/denials.log` in
// the base repository, so the cockpit can surface clusters without
// interrupting the operator. An `allow` decision is never logged.
//
// It no-ops (no stdout, no log line) unless the repository has a
// `.claude/port.config.json`. A plugin's hooks fire in EVERY session once
// installed at user scope, regardless of working directory, so without this
// guard installing port would start deciding and logging in unrelated
// projects.
import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { allowMatchers, decide } from './lib/guard-rules.mjs';

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

function actorOf(who) {
  if (who?.agent) return `port:${who.agent}`;
  if (who?.signal) return `subagent:${who.signal}`;
  return null;
}

function log(dir, decision, actor, subject) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, 'denials.log'),
    [new Date().toISOString(), decision, actor, field(subject, 500)].join('\t') + '\n',
  );
}

const cwd = process.cwd();
const configRoot = findUp(cwd, join('.claude', 'port.config.json'));

// Silent outside a port-managed repository.
if (configRoot) {
  try {
    const payload = JSON.parse(readFileSync(0, 'utf8')); // PreToolUse JSON on stdin
    const config = JSON.parse(readFileSync(join(configRoot, '.claude', 'port.config.json'), 'utf8'));
    const sessionRequiredPaths = config?.sessionRequiredPaths ?? ['CLAUDE.md', '.claude/**'];

    const matchers = allowMatchers([
      join(configRoot, '.claude', 'settings.json'),
      join(configRoot, '.claude', 'settings.local.json'),
    ]);

    const result = decide({ payload, matchers, sessionRequiredPaths, root: configRoot });
    const logDir = join(baseRepoRoot(cwd), '.agents');
    const actor = actorOf(result.who) ?? `session:${field(payload?.session_id, 40) || 'unknown'}`;

    if (result.decision === 'deny') {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: result.reason,
          },
        }),
      );
      log(logDir, 'deny', actor, result.subject);
    } else if (result.decision === 'miss') {
      log(logDir, 'miss', actor, result.subject);
    }
    // 'allow' — nothing to log, nothing to emit.
  } catch {
    // Fail open, but visibly: a malformed payload or any internal error
    // never blocks the tool call, but it is recorded rather than silent.
    try {
      log(join(baseRepoRoot(cwd), '.agents'), 'hook-error', 'session:unknown', '');
    } catch {
      // Never block or fail the tool call.
    }
  }
}
process.exit(0);
