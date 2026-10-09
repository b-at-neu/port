// PreToolUse hook: denies a subagent call missing the allowlist or targeting a
// sessionRequiredPaths path, plus rules for any caller. No-ops outside a port-managed repository.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { allowMatchers, decide, callerKind, invokedCockpitSkill } from './lib/guard-rules.mjs';
import { gateClearAttempt, switchesBranch } from './lib/command-rules.mjs';
import { classifyOwnership } from './lib/ownership-rules.mjs';
import { recentOperatorMessages } from './lib/operator-rules.mjs';

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
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
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
    const needsHumanLabel = config?.labels?.needsHuman ?? 'needs human';
    const approvedLabel = config?.labels?.approved ?? 'approved';

    const matchers = allowMatchers([
      join(configRoot, '.claude', 'settings.json'),
      join(configRoot, '.claude', 'settings.local.json'),
    ]);

    // Every worktree of a checkout resolves to the one ownership record, the base repository root.
    const baseRoot = baseRepoRoot(cwd);
    const cockpitFilePath = join(baseRoot, '.agents', 'cockpit.json');
    const isWriteToolCall = payload?.tool_name === 'Write' || payload?.tool_name === 'Edit' || payload?.tool_name === 'NotebookEdit';
    const writeTargetsCockpitFile =
      isWriteToolCall &&
      typeof payload?.tool_input?.file_path === 'string' &&
      payload.tool_input.file_path.length > 0 &&
      resolve(configRoot, payload.tool_input.file_path) === cockpitFilePath;

    // Reads and classifies the ownership record for an Agent call or a write targeting it.
    let ownership;
    if (payload?.tool_name === 'Agent' || writeTargetsCockpitFile) {
      const exists = existsSync(cockpitFilePath);
      const text = exists ? readFileSync(cockpitFilePath, 'utf8') : '';
      ownership = classifyOwnership(exists, text, config?.repo);
    }

    // Gate/branch/approval need the session transcript, read once for all three; any read failure yields `null`.
    let operatorMessages = null;
    let isCockpitSession = null;
    if (payload?.tool_name === 'Bash' && typeof payload?.tool_input?.command === 'string') {
      const who = callerKind(payload);
      if (!who.isSubagent && !who.isOperatorWorktree) {
        const command = payload.tool_input.command;
        const gate = gateClearAttempt(command, needsHumanLabel);
        const approval = gateClearAttempt(command, approvedLabel);
        const needsTranscript = gate.isAttempt || approval.isAttempt || switchesBranch(command);
        if (needsTranscript && typeof payload?.transcript_path === 'string') {
          try {
            const transcript = readFileSync(payload.transcript_path, 'utf8');
            if (gate.isAttempt || approval.isAttempt) operatorMessages = recentOperatorMessages(transcript);
            isCockpitSession = invokedCockpitSkill(transcript);
          } catch {
            operatorMessages = null;
            isCockpitSession = null;
          }
        }
      }
    } else if (payload?.tool_name === 'Agent' || writeTargetsCockpitFile) {
      const who = callerKind(payload);
      const appOwnsItOrUnknown = ownership?.kind === 'app' || ownership?.kind === 'unreadable';
      const needsTranscript = payload?.tool_name === 'Agent' ? !who.isSubagent && appOwnsItOrUnknown : !who.isSubagent;
      if (needsTranscript && typeof payload?.transcript_path === 'string') {
        try {
          isCockpitSession = invokedCockpitSkill(readFileSync(payload.transcript_path, 'utf8'));
        } catch {
          isCockpitSession = null;
        }
      }
    }

    const result = decide({
      payload,
      matchers,
      sessionRequiredPaths,
      root: configRoot,
      needsHumanLabel,
      operatorMessages,
      isCockpitSession,
      ownership,
      cockpitFilePath,
      repo: config?.repo,
      approvedLabel,
    });
    const logDir = join(baseRoot, '.agents');
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
    } else if (result.decision === 'gate-clear') {
      // Allowed — no stdout, so the call proceeds — but logged as the
      // auditable record of a human gate being removed.
      log(logDir, 'gate-clear', actor, result.subject);
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
// Setting exitCode and letting the process end naturally avoids process.exit(0) truncating
// the deny JSON on Windows, where stdout is asynchronous when piped.
process.exitCode = 0;
