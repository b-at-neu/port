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
 *  `agentType` like `port:plan-agent`.
 *
 *  Also resolves `isOperatorWorktree` — an `/port:implement` `impl-<n>`
 *  worktree — **independently** of the three subagent signals, so the
 *  existing allowlist and write rules keep their exact prior behaviour; only
 *  the cockpit rules (loop, gate) consult it. */
export function callerKind(payload) {
  const cwd = payload?.cwd;
  const isOperatorWorktree = typeof cwd === 'string' && cwd.includes('/.claude/worktrees/impl-');

  if (payload?.agent_type || payload?.agent_id) {
    return { isSubagent: true, isOperatorWorktree, agent: payload.agent_type ?? null, signal: 'agent_type' };
  }
  const transcript = payload?.transcript_path;
  if (typeof transcript === 'string' && transcript.includes('/subagents/agent-')) {
    return { isSubagent: true, isOperatorWorktree, agent: null, signal: 'transcript' };
  }
  // Only a dispatched agent's own worktree — named `agent-<hash>` by the
  // harness — is in scope here. `/port:implement` creates `impl-<n>`
  // worktrees for the *operator's own* session, which must never match:
  // that skill's whole premise is that this guard does not fire there.
  if (typeof cwd === 'string' && cwd.includes('/.claude/worktrees/agent-')) {
    return { isSubagent: true, isOperatorWorktree, agent: null, signal: 'worktree' };
  }
  return { isSubagent: false, isOperatorWorktree, agent: null, signal: null };
}

/** Tokenizes a shell command, respecting single/double quotes — a quoted
 *  span's contents (spaces included) become one token, so a flag value like
 *  `"needs human"` is not split in two. */
function tokenize(command) {
  const tokens = [];
  let i = 0;
  while (i < command.length) {
    while (i < command.length && /\s/.test(command[i])) i++;
    if (i >= command.length) break;
    let token = '';
    while (i < command.length && !/\s/.test(command[i])) {
      const c = command[i];
      if (c === '"' || c === "'") {
        const quote = c;
        i++;
        while (i < command.length && command[i] !== quote) {
          token += command[i];
          i++;
        }
        i++; // skip the closing quote, if any
      } else {
        token += c;
        i++;
      }
    }
    tokens.push(token);
  }
  return tokens;
}

/** True if `text` carries `keyword` at a shell command position — the start
 *  of the string, or preceded by whitespace, `;`, `&`, `|`, or `(` — and
 *  followed by a word boundary. This is what keeps `github` from matching
 *  `gh` and a `for` inside a longer identifier from matching the loop
 *  keyword. */
function atCommandPosition(text, keyword) {
  const re = new RegExp(`(?:^|[\\s;&|(])${keyword}(?=[\\s;&|)]|$)`);
  return re.test(text);
}

/** Replaces every quoted span's *contents* with nothing, so every syntactic
 *  test below runs on the command's shell structure, never on the contents
 *  of a `-b`/`-m`/`--jq` argument. This is what keeps
 *  `gh issue comment -b "a loop for each item to do"` out of the loop rule. */
export function stripQuoted(command) {
  return command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

/** A `for`/`while`/`until` keyword **and** a `do` keyword, each at a command
 *  position, on the quote-stripped command — the exact shape #120 froze the
 *  pipeline with. */
export function usesShellLoop(command) {
  const stripped = stripQuoted(command);
  const hasLoopKeyword = ['for', 'while', 'until'].some((kw) => atCommandPosition(stripped, kw));
  return hasLoopKeyword && atCommandPosition(stripped, 'do');
}

/** `gh` or `git`, at a command position, on the quote-stripped command — so a
 *  loop over an unrelated binary is never denied. */
export function targetsGhOrGit(command) {
  const stripped = stripQuoted(command);
  return atCommandPosition(stripped, 'gh') || atCommandPosition(stripped, 'git');
}

/** Detects a `gh pr edit`/`gh issue edit` call that removes `label`, and the
 *  item numbers it targets — a bare positional digit, or the trailing digits
 *  of a `github.com/**\/(issues|pull)/<n>` URL. Quote-aware, so a label name
 *  with spaces (`"needs human"`) is read correctly. `numbers` is always
 *  collected, even when `isAttempt` is false, so a caller never re-tokenizes. */
export function gateClearAttempt(command, label) {
  const tokens = tokenize(command);
  const isEdit =
    tokens[0] === 'gh' &&
    ((tokens[1] === 'pr' && tokens[2] === 'edit') || (tokens[1] === 'issue' && tokens[2] === 'edit'));

  const numbers = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const prev = tokens[i - 1] ?? '';
    if (prev.startsWith('-')) continue; // a flag's value, not a positional item number
    if (/^\d+$/.test(t)) {
      numbers.push(Number(t));
      continue;
    }
    const m = /\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/.exec(t);
    if (m) numbers.push(Number(m[1]));
  }

  if (!isEdit) return { isAttempt: false, numbers };

  const target = label.trim().toLowerCase();
  let isAttempt = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let value = null;
    if (t === '--remove-label') value = tokens[i + 1] ?? '';
    else if (t.startsWith('--remove-label=')) value = t.slice('--remove-label='.length);
    if (value === null) continue;
    if (value.split(',').map((v) => v.trim().toLowerCase()).includes(target)) isAttempt = true;
  }

  return { isAttempt, numbers };
}

/** The last `limit` operator (human) messages found in a session transcript's
 *  JSONL text, oldest first. Drops harness-injected wrapper texts (slash
 *  command expansions, the `Caveat:` preamble) and `tool_result`-only user
 *  entries, which are not something a human typed. Returns `null` when
 *  **no** parseable user entry exists at all, so "unreadable" is
 *  distinguishable from "read, and the item is not named". */
export function recentOperatorMessages(jsonlText, limit = 5) {
  if (typeof jsonlText !== 'string' || jsonlText.length === 0) return null;
  const texts = [];
  for (const line of jsonlText.split('\n')) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    let entry;
    try {
      entry = JSON.parse(trimmedLine);
    } catch {
      continue;
    }
    if (entry?.type !== 'user' || entry?.isMeta === true) continue;

    const content = entry?.message?.content ?? entry?.content;
    let text;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      const textBlock = content.find((b) => b?.type === 'text' && typeof b.text === 'string');
      if (!textBlock) continue; // a tool_result-only entry — not something a human typed
      text = textBlock.text;
    } else {
      continue;
    }

    const trimmedText = text.trim();
    if (!trimmedText) continue;
    if (/^<command-[a-z-]+>/.test(trimmedText)) continue; // slash-command expansion wrapper
    if (/^Caveat:/.test(trimmedText)) continue; // harness-injected preamble
    texts.push(trimmedText);
  }
  if (texts.length === 0) return null;
  return texts.slice(-limit);
}

/** True when every number in `numbers` is named in at least one of
 *  `messages`, as `#N` or as a standalone `N`. `messages === null` means the
 *  transcript could not be read at all — unverifiable, not unauthorised, so
 *  this returns `null` rather than `false`. */
export function operatorNamed(numbers, messages) {
  if (messages === null) return null;
  const namesNumber = (n, message) =>
    new RegExp(`#${n}(?!\\d)`).test(message) || new RegExp(`(?:^|[^\\d])${n}(?!\\d)`).test(message);
  return numbers.every((n) => messages.some((m) => namesNumber(n, m)));
}

/** The decision for one PreToolUse call.
 *
 *  `decision` is one of:
 *  - `'allow'`      — nothing to do, nothing logged.
 *  - `'deny'`       — a dispatched subagent missed the allowlist, wrote to a
 *                     `sessionRequiredPaths` path, wrapped a `gh`/`git` call
 *                     in a shell loop, or attempted an unauthorised
 *                     `needsHuman` gate clear. Emit the hook deny output.
 *  - `'miss'`       — a non-subagent command missed the allowlist. Logged
 *                     for visibility; the normal permission prompt still
 *                     runs.
 *  - `'gate-clear'` — a `needsHuman` gate clear that is allowed to proceed
 *                     (operator-named, or unverifiable). Not a denial;
 *                     logged as the audit record for the clear.
 *
 *  Rule order for a Bash call: gate → loop → allowlist. Each of the first
 *  two returns its own specific reason instead of falling through to the
 *  generic allowlist miss/deny. Both are inert — `allow` immediately —
 *  for `who.isOperatorWorktree`, an `/port:implement` session that must
 *  stay unguarded by the cockpit rules.
 *
 *  `needsHumanLabel` and `operatorMessages` are optional: omitting
 *  `needsHumanLabel` skips the gate rule entirely (used by callers with no
 *  gate to guard), and `operatorMessages` is the caller's *already-read*
 *  transcript tail (`recentOperatorMessages`) — `decide` never does I/O
 *  itself. */
export function decide({ payload, matchers, sessionRequiredPaths, root, needsHumanLabel, operatorMessages }) {
  const who = callerKind(payload);
  const toolName = payload?.tool_name;

  if (toolName === 'Bash') {
    const command = payload?.tool_input?.command;
    if (typeof command !== 'string' || command.length === 0) {
      return { decision: 'allow', who, subject: null };
    }

    // Gate rule — evaluated first so an unauthorised clear gets its own
    // reason, never the generic allowlist copy.
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
        // named === true, or null (unverifiable transcript) — allow, and
        // let the caller log this as the audit record for the clear.
        return { decision: 'gate-clear', who, subject: command };
      }
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
