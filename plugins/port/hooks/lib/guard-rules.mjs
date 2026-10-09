// Pure classifier for the agent-guard PreToolUse hook — kept separate from agent-guard.mjs's
// stdin/stdout plumbing so layer 1 checks can unit-test decision logic directly.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, basename, relative, resolve } from 'node:path';
import {
  gateClearAttempt,
  pluginInstallMutation,
  switchesBranch,
  targetsGhOrGit,
  usesShellLoop,
} from './command-rules.mjs';
import { cockpitWriteDenial, dispatchDenial } from './ownership-rules.mjs';
import { operatorNamed } from './operator-rules.mjs';

/** Canonicalizes `p` via realpath, falling back a directory level for a not-yet-created leaf. */
export function realCanonical(p) {
  const resolved = resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    try {
      return resolve(realpathSync(dirname(resolved)), basename(resolved));
    } catch {
      return resolved;
    }
  }
}

/** Compiles a glob (`**` → any depth, `*` → one path segment, else escaped) into an
 *  anchored RegExp, for `sessionRequiredPaths` globs against an already-relativized path. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') {
      re += '[^/]*';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** True if `pattern` (the inside of `Bash(...)`) matches `command`. A trailing ` *` is a
 *  prefix match on a token boundary; anything else must match the whole command exactly. */
export function bashPatternMatches(pattern, command) {
  if (pattern.endsWith(' *')) {
    const prefix = pattern.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `);
  }
  return command === pattern;
}

/** Rewrites an in-repo absolute invocation back to its repo-relative form. Fails closed
 *  byte-for-byte: a command with no occurrence of `root` is returned exactly as given. */
export function repoRelative(command, root) {
  const posixRoot = toPosix(root);
  const posixCommand = toPosix(command);
  if (typeof posixRoot !== 'string' || typeof posixCommand !== 'string') return command;
  const escapedRoot = posixRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quotedRoot = new RegExp(`(['"])${escapedRoot}/([^'"]*)\\1`, 'g');
  const stripped = posixCommand.replace(quotedRoot, '$2').split(`${posixRoot}/`).join('');
  return stripped === posixCommand ? command : stripped;
}

/** Reads `permissions.allow` out of each settings file that exists (missing/unparsable
 *  skipped), returning compiled Bash matchers, or `null` if none yielded any entry. */
export function allowMatchers(settingsFiles) {
  const patterns = [];
  for (const file of settingsFiles) {
    if (!existsSync(file)) continue;
    let json;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    for (const entry of json?.permissions?.allow ?? []) {
      const m = /^Bash\((.*)\)$/.exec(entry);
      if (m) patterns.push(m[1]);
    }
  }
  if (patterns.length === 0) return null;
  return patterns.map((pattern) => ({
    tool: 'Bash',
    pattern,
    test: (command) => bashPatternMatches(pattern, command),
  }));
}

/** Forward-slashed, so a substring test matches on Windows too. */
const toPosix = (p) => (typeof p === 'string' ? p.split('\\').join('/') : p);

/** Identifies whether `payload` is from a dispatched subagent, plus `isOperatorWorktree`
 *  (exempted by cockpit rules) and `isManagedWorktree` (never exempted, for installs). */

export function callerKind(payload) {
  const cwd = toPosix(payload?.cwd);
  const isOperatorWorktree = typeof cwd === 'string' && cwd.includes('/.claude/worktrees/impl-');
  const isManagedWorktree = typeof cwd === 'string' && cwd.includes('/.claude/worktrees/');

  if (payload?.agent_type || payload?.agent_id) {
    return { isSubagent: true, isOperatorWorktree, isManagedWorktree, agent: payload.agent_type ?? null, signal: 'agent_type' };
  }
  const transcript = toPosix(payload?.transcript_path);
  if (typeof transcript === 'string' && transcript.includes('/subagents/agent-')) {
    return { isSubagent: true, isOperatorWorktree, isManagedWorktree, agent: null, signal: 'transcript' };
  }
  // Only a dispatched agent's own `agent-<hash>` worktree is in scope here — `/port:implement`'s
  // `impl-<n>` worktrees are the operator's own session and must never match.
  if (typeof cwd === 'string' && cwd.includes('/.claude/worktrees/agent-')) {
    return { isSubagent: true, isOperatorWorktree, isManagedWorktree, agent: null, signal: 'worktree' };
  }
  return { isSubagent: false, isOperatorWorktree, isManagedWorktree, agent: null, signal: null };
}

/** True when `jsonlText` carries the harness's slash-command expansion wrapper around
 *  `pipeline` — the tell this session invoked the cockpit skill. Returns `false` for unreadable text. */
export function invokedCockpitSkill(jsonlText) {
  if (typeof jsonlText !== 'string' || jsonlText.length === 0) return false;
  const tag = ['command', 'name'].join('-');
  const wrapper = new RegExp(`<${tag}>/?(?:[a-z0-9_-]+:)?pipeline<\\/${tag}>`);
  return wrapper.test(jsonlText);
}

/** The decision for one PreToolUse call: `allow`, `deny`, `miss` (non-subagent allowlist miss,
 *  prompt still runs), or `gate-clear` (an allowed removal, logged as the audit record). */
export function decide({
  payload,
  matchers,
  sessionRequiredPaths,
  root,
  needsHumanLabel,
  operatorMessages,
  isCockpitSession,
  ownership,
  cockpitFilePath,
  repo,
  approvedLabel,
}) {
  const who = callerKind(payload);
  const toolName = payload?.tool_name;

  if (toolName === 'Agent') {
    const denial = dispatchDenial({ toolName, who, isCockpitSession, ownership });
    if (denial) return denial;
    return { decision: 'allow', who, subject: null };
  }

  if (toolName === 'Bash') {
    const command = payload?.tool_input?.command;
    if (typeof command !== 'string' || command.length === 0) {
      return { decision: 'allow', who, subject: null };
    }

    // Gate rule — evaluated first so an unauthorised clear gets its own reason. <labels.approved>
    // is a separate, never-denying rule (the approval arm, below): the hook can only audit it.
    if (needsHumanLabel && !who.isOperatorWorktree) {
      const gate = gateClearAttempt(command, needsHumanLabel);
      if (gate.isAttempt) {
        if (who.isSubagent) {
          return {
            decision: 'deny',
            who,
            subject: command,
            reason: `port: only an operator can clear the "${needsHumanLabel}" gate. Stop and emit BLOCKED: <what you needed>.`,
          };
        }
        if (!gate.hasNumbers) {
          // No identifier to check an operator message against — must never fall through to operatorNamed's vacuously-true `[].every(...)`.
          return {
            decision: 'deny',
            who,
            subject: command,
            reason: `port: removing "${needsHumanLabel}" is denied — the command names no item number (no bare digit, no issues/pull URL), so it can't be checked against what the operator named. Re-run with the explicit number after the operator says so, e.g. gh pr edit <n> --remove-label "${needsHumanLabel}".`,
          };
        }
        const named = operatorNamed(gate.numbers, operatorMessages ?? null);
        if (named === false) {
          const n = gate.numbers[0] ?? '<n>';
          return {
            decision: 'deny',
            who,
            subject: command,
            reason: `port: removing "${needsHumanLabel}" from #${gate.numbers.join(', #')} is denied — no operator message in the last 5 turns names that item. The gate clears only when the operator says so: ask them, and run this after they do (unblock #${n}).`,
          };
        }
        // named === true, or null (unverifiable transcript) — allow, logged as the audit record.
        return { decision: 'gate-clear', who, subject: command };
      }
    }

    // Install rule — every install scope shares one installPath; deliberately not exempt for
    // `who.isOperatorWorktree`, unlike the other cockpit-class rules below.
    if (who.isManagedWorktree && pluginInstallMutation(command)) {
      return {
        decision: 'deny',
        who,
        subject: command,
        reason:
          'port: installing, uninstalling, or changing a plugin marketplace from inside a managed worktree is denied — every install scope shares one installPath, so this would silently repoint every session on the machine and keep doing so after this worktree is gone. Run it from the main checkout instead.',
      };
    }

    // Branch rule — a cockpit session checking out/switching branches out from under its own
    // startup refusal. `isCockpitSession === null` (unreadable) allows, matching the gate rule.
    if (!who.isOperatorWorktree && !who.isSubagent && isCockpitSession && switchesBranch(command)) {
      return {
        decision: 'deny',
        who,
        subject: command,
        reason:
          'port: switching branches from a cockpit session is denied (#216) — the startup preflight\'s hard stop names the carrying branch or /port:init; it is never escaped by checking one out from here. Stop and emit the preflight\'s hard-stop message rather than changing the operator\'s branch.',
      };
    }

    // Loop rule.
    if (!who.isOperatorWorktree && usesShellLoop(command) && targetsGhOrGit(command)) {
      return {
        decision: 'deny',
        who,
        subject: command,
        reason:
          'port: a gh/git call inside a shell loop is denied — one iteration lands and the rest die with the turn (#120). Batch issues in one call: gh issue edit 63 67 71 --repo <repo> --remove-label "planning" --add-label "ready". gh pr edit takes one number, so one call per pull request — then re-query to confirm every item moved.',
      };
    }

    // Approval arm — audit-only route off <labels.approved>. Never denies: it only adds a
    // 'gate-clear' log line on top of whatever the allowlist decides below.
    if (approvedLabel && !who.isSubagent && !who.isOperatorWorktree) {
      const approval = gateClearAttempt(command, approvedLabel);
      if (approval.isAttempt && approval.hasNumbers && operatorNamed(approval.numbers, operatorMessages ?? null) === true) {
        return { decision: 'gate-clear', who, subject: command };
      }
    }

    if (matchers === null) {
      return { decision: 'allow', who, subject: command };
    }
    // An absolute in-repo invocation is the same command as its repo-relative allowlisted
    // form — resolved here, at the miss, so a logged deny/miss still shows what was typed.
    const matched =
      matchers.some((m) => m.test(command)) || matchers.some((m) => m.test(repoRelative(command, root)));
    if (matched) return { decision: 'allow', who, subject: command };
    return {
      decision: who.isSubagent ? 'deny' : 'miss',
      who,
      subject: command,
      reason:
        'port: this command is not on the repository\'s allowlist, so it is denied for dispatched agents (no operator prompt). Use Read/Grep/Glob instead of shelling out; if you genuinely need this command, stop and emit BLOCKED: <command> — <what you needed>.',
    };
  }

  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
    const filePath = payload?.tool_input?.file_path;

    // Ownership rule, write-tool arm — denied for every caller, with the one exception
    // `cockpitWriteDenial` itself carves out (a terminal's own preflight write).
    if (cockpitFilePath && typeof filePath === 'string' && filePath.length > 0) {
      const resolvedPath = resolve(root, filePath);
      if (realCanonical(resolvedPath) === realCanonical(cockpitFilePath)) {
        const denial = cockpitWriteDenial({
          toolName,
          who,
          filePath,
          cockpitFilePath: resolvedPath,
          isCockpitSession,
          content: payload?.tool_input?.content,
          repo,
          currentOwnership: ownership,
        });
        if (denial) return denial;
      }
    }

    if (!who.isSubagent || typeof filePath !== 'string' || filePath.length === 0) {
      return { decision: 'allow', who, subject: filePath ?? null };
    }
    const relPath = relative(root, resolve(root, filePath)).split('\\').join('/');
    const globs = sessionRequiredPaths ?? [];
    const matched = globs.some((glob) => globToRegExp(glob).test(relPath));
    if (!matched) return { decision: 'allow', who, subject: relPath };
    return {
      decision: 'deny',
      who,
      subject: relPath,
      reason: `port: ${relPath} matches sessionRequiredPaths — a dispatched agent cannot edit it by any route. Stop and emit BLOCKED: …; this work needs /port:implement in an operator session.`,
    };
  }

  return { decision: 'allow', who, subject: null };
}
