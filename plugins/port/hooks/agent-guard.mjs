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
// Five more rules apply to *any* caller, cockpit included: a `gh`/`git`
// call wrapped in a shell loop (#120), an unauthorised removal of the
// `needsHuman` gate label (#138), an add/remove of a plan-gate label while
// an external claim holds it (#206), a `claude plugin` install/uninstall/
// marketplace mutation run from inside any `.claude/worktrees/` cwd (#144),
// and a cockpit session `git checkout`/`git switch`ing branches out from
// under its own startup refusal (#216). Loop, gate, claim, and branch exempt
// an `/port:implement` operator worktree; the install rule deliberately does
// not, since every install scope shares one `installPath` regardless of who
// is typing the command — and the claim rule's own write-tool arm (denying
// a write to the claim file itself) does not exempt it either, for the same
// reason. The gate and branch rules are the two call paths that do extra
// I/O — reading the calling session's transcript — and only when the
// command actually matches what each rule guards, from a non-subagent,
// non-operator-worktree caller. The claim rule's own read (the claim file
// itself) runs whenever a Bash call carries `--add-label`/`--remove-label`
// or a write targets the claim file path, independent of caller identity —
// the write-tool arm needs the result for every caller, not only a
// non-subagent one.
//
// Every decision — deny, a same-shape miss from a non-subagent session, an
// allowed gate clear, or an internal failure — is logged to a gitignored
// `.agents/denials.log` in the base repository, so the cockpit can surface
// clusters without interrupting the operator. An `allow` decision is never
// logged.
//
// It no-ops (no stdout, no log line) unless the repository has a
// `.claude/port.config.json`. A plugin's hooks fire in EVERY session once
// installed at user scope, regardless of working directory, so without this
// guard installing port would start deciding and logging in unrelated
// projects.
import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { allowMatchers, decide, callerKind, recentOperatorMessages, invokedCockpitSkill } from './lib/guard-rules.mjs';
import { gateClearAttempt, switchesBranch } from './lib/command-rules.mjs';
import { classifyGateClaim } from './lib/claim-rules.mjs';

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
    const needsHumanLabel = config?.labels?.needsHuman ?? 'needs human';

    const matchers = allowMatchers([
      join(configRoot, '.claude', 'settings.json'),
      join(configRoot, '.claude', 'settings.local.json'),
    ]);

    // The claim rule's own path — every worktree of a checkout resolves to
    // the one file, the base repository root, never a per-worktree copy.
    const baseRoot = baseRepoRoot(cwd);
    const claimFilePath = join(baseRoot, '.agents', 'gate-claim.json');
    const planGateLabels = [
      config?.labels?.planReview ?? 'plan review',
      config?.labels?.planApproved ?? 'plan approved',
      config?.labels?.planChangesRequested ?? 'plan changes requested',
    ];

    // The claim rule's own extra I/O — reading and classifying the claim
    // file — runs only when a Bash call actually carries a label-editing
    // flag, the same "extra I/O only where the rule might fire" shape the
    // gate/branch transcript read below already uses. The write-tool arm
    // needs no read at all: it only compares `file_path` against
    // `claimFilePath`, decided inside `decide` itself.
    let planGateClaim;
    if (
      payload?.tool_name === 'Bash' &&
      typeof payload?.tool_input?.command === 'string' &&
      /--(?:add|remove)-label/.test(payload.tool_input.command)
    ) {
      const exists = existsSync(claimFilePath);
      const text = exists ? readFileSync(claimFilePath, 'utf8') : '';
      planGateClaim = classifyGateClaim(exists, text, config?.repo);
    }

    // The gate and branch rules are the two paths that need extra I/O — the
    // calling session's transcript — so the read only happens when either
    // rule's own command test says it might apply, and only for a caller
    // `decide` will not already deny outright (a subagent) or exempt
    // outright (an operator worktree). One read serves both rules. A
    // missing path, an unreadable file, or a parse failure all yield `null`
    // (unverifiable) for both, never a throw.
    let operatorMessages = null;
    let isCockpitSession = null;
    if (payload?.tool_name === 'Bash' && typeof payload?.tool_input?.command === 'string') {
      const who = callerKind(payload);
      if (!who.isSubagent && !who.isOperatorWorktree) {
        const command = payload.tool_input.command;
        const gate = gateClearAttempt(command, needsHumanLabel);
        const needsTranscript = gate.isAttempt || switchesBranch(command);
        if (needsTranscript && typeof payload?.transcript_path === 'string') {
          try {
            const transcript = readFileSync(payload.transcript_path, 'utf8');
            if (gate.isAttempt) operatorMessages = recentOperatorMessages(transcript);
            isCockpitSession = invokedCockpitSkill(transcript);
          } catch {
            operatorMessages = null;
            isCockpitSession = null;
          }
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
      planGateClaim,
      planGateLabels,
      claimFilePath,
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
// Nothing runs after this line in either branch, so setting exitCode and
// letting the process end naturally is equivalent to exiting immediately —
// except on Windows, where process.stdout is asynchronous when connected to
// a pipe, and an immediate process.exit(0) can truncate the deny JSON this
// hook just wrote to stdout.
process.exitCode = 0;
