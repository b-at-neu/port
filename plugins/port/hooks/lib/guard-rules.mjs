// Pure classifier for the agent-guard PreToolUse hook.
//
// Kept separate from agent-guard.mjs (which owns stdin/stdout/exit-code
// plumbing) so scripts/checks.mjs can unit-test the decision logic directly —
// no stdin, no plugin install, no model call.
import { readFileSync, existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';

/** Compiles a glob (`**` → any depth, `*` → one path segment, everything else
 *  escaped) into an anchored RegExp. Used for `sessionRequiredPaths` globs
 *  against a path already relativized to the config root. */
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

/** True if `pattern` (the inside of `Bash(...)`) matches `command`. A
 *  trailing ` *` is a prefix match on a token boundary; anything else must
 *  match the whole command exactly. This mirrors the shape of every entry in
 *  `templates/permissions.base.json` — it does not attempt to parse full
 *  shell-glob semantics beyond that. */
function bashPatternMatches(pattern, command) {
  if (pattern.endsWith(' *')) {
    const prefix = pattern.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `);
  }
  return command === pattern;
}

/** Reads `permissions.allow` out of each settings file that exists (missing
 *  or unparsable files are skipped, never fatal), and returns the compiled
 *  Bash matchers. Returns `null` when no settings file yielded any Bash
 *  allow entry at all, so callers can fail open on "no parseable allowlist"
 *  rather than deny everything. */
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

/** Identifies whether `payload` (a PreToolUse hook payload) originates from a
 *  dispatched subagent. Any one of three independent signals is sufficient —
 *  never a name list, which fails open on a rename or a namespaced
 *  `agentType` like `port:plan-agent`. */
export function callerKind(payload) {
  if (payload?.agent_type || payload?.agent_id) {
    return { isSubagent: true, agent: payload.agent_type ?? null, signal: 'agent_type' };
  }
  const transcript = payload?.transcript_path;
  if (typeof transcript === 'string' && transcript.includes('/subagents/agent-')) {
    return { isSubagent: true, agent: null, signal: 'transcript' };
  }
  // Only a dispatched agent's own worktree — named `agent-<hash>` by the
  // harness — is in scope here. `/port:implement` creates `impl-<n>`
  // worktrees for the *operator's own* session, which must never match:
  // that skill's whole premise is that this guard does not fire there.
  const cwd = payload?.cwd;
  if (typeof cwd === 'string' && cwd.includes('/.claude/worktrees/agent-')) {
    return { isSubagent: true, agent: null, signal: 'worktree' };
  }
  return { isSubagent: false, agent: null, signal: null };
}

/** The decision for one PreToolUse call.
 *
 *  `decision` is one of:
 *  - `'allow'`  — nothing to do, nothing logged.
 *  - `'deny'`   — a dispatched subagent missed the allowlist, or wrote to a
 *                 `sessionRequiredPaths` path. Emit the hook deny output.
 *  - `'miss'`   — a non-subagent command missed the allowlist. Logged for
 *                 visibility; the normal permission prompt still runs.
 */
export function decide({ payload, matchers, sessionRequiredPaths, root }) {
  const who = callerKind(payload);
  const toolName = payload?.tool_name;

  if (toolName === 'Bash') {
    const command = payload?.tool_input?.command;
    if (typeof command !== 'string' || command.length === 0) {
      return { decision: 'allow', who, subject: null };
    }
    if (matchers === null) {
      return { decision: 'allow', who, subject: command };
    }
    const matched = matchers.some((m) => m.test(command));
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
