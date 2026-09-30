// Pure classifier for the agent-guard PreToolUse hook.
//
// Kept separate from agent-guard.mjs (which owns stdin/stdout/exit-code
// plumbing) so the port repository's own layer 1 checks can unit-test the
// decision logic directly — no stdin, no plugin install, no model call.
//
// The pure command-syntax predicates (#216) live in the sibling
// command-rules.mjs — this file was at 483/500 lines, and the branch rule
// below needed room the ceiling did not have. This file keeps caller
// identity, settings/transcript I/O, and `decide` itself. The plan-gate
// claim classifier (#206) lives in the sibling claim-rules.mjs for the same
// reason — `decide` only ever consumes its already-classified verdict,
// never imports it directly.
import { readFileSync, existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  gateClearAttempt,
  labelEditAttempt,
  pluginInstallMutation,
  switchesBranch,
  targetsGhOrGit,
  usesShellLoop,
} from './command-rules.mjs';

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
export function bashPatternMatches(pattern, command) {
  if (pattern.endsWith(' *')) {
    const prefix = pattern.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `);
  }
  return command === pattern;
}

/** Rewrites an in-repo absolute invocation back to its repo-relative form
 *  (#205) — a worktree agent's `configRoot` is its worktree, so `node
 *  <root>/<script>` is the identical command to the allowlisted `node
 *  <script>`, just spelled with the harness's requested absolute path.
 *  A quoted absolute argument (`"<root>/x" check "<root>/y"`)
 *  has its surrounding quotes dropped along with the root prefix, since an
 *  unquoted relative path is the form the allowlist actually matches — any
 *  *other* quoted span is left untouched. Fails closed **byte-for-byte**: a
 *  command with no occurrence of `root` (elsewhere on disk, or a relative `..`
 *  escape) is returned exactly as it came in — not separator-normalized —
 *  because normalizing it would be a second, silent effect of a
 *  security-relevant classifier: a backslash-spelled command outside the root
 *  would get reshaped into the POSIX form the allow patterns are written in,
 *  widening the match for a path this function deliberately declines to
 *  resolve. Normalization is therefore only ever a by-product of an actual
 *  strip. */
export function repoRelative(command, root) {
  const posixRoot = toPosix(root);
  const posixCommand = toPosix(command);
  if (typeof posixRoot !== 'string' || typeof posixCommand !== 'string') return command;
  const escapedRoot = posixRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quotedRoot = new RegExp(`(['"])${escapedRoot}/([^'"]*)\\1`, 'g');
  const stripped = posixCommand.replace(quotedRoot, '$2').split(`${posixRoot}/`).join('');
  return stripped === posixCommand ? command : stripped;
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
 *  the cockpit rules (loop, gate) consult it.
 *
 *  And `isManagedWorktree` — cwd sits anywhere under `.claude/worktrees/`,
 *  whichever naming scheme (`agent-<hash>` or `impl-<n>`) — resolved
 *  independently again, for the plugin-install refusal rule below. Unlike
 *  `isOperatorWorktree`, this one is **not** exempt for an `/port:implement`
 *  session: the blast radius of an install performed from a worktree is
 *  identical whether the caller is a dispatched agent or the operator, since
 *  every install scope shares one `installPath` regardless of who is typing. */
/** Forward-slashed, so a substring test written against POSIX-shaped
 *  worktree/transcript paths still matches on Windows, where `cwd` and
 *  `transcript_path` arrive with `\` separators. */
const toPosix = (p) => (typeof p === 'string' ? p.split('\\').join('/') : p);

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
  // Only a dispatched agent's own worktree — named `agent-<hash>` by the
  // harness — is in scope here. `/port:implement` creates `impl-<n>`
  // worktrees for the *operator's own* session, which must never match:
  // that skill's whole premise is that this guard does not fire there.
  if (typeof cwd === 'string' && cwd.includes('/.claude/worktrees/agent-')) {
    return { isSubagent: true, isOperatorWorktree, isManagedWorktree, agent: null, signal: 'worktree' };
  }
  return { isSubagent: false, isOperatorWorktree, isManagedWorktree, agent: null, signal: null };
}

/** True when `jsonlText` (a session transcript's raw JSONL) carries the
 *  harness's slash-command expansion wrapper element around `pipeline`, with
 *  an optional leading `/` and an optional `<ns>:` namespace prefix — the
 *  tell that this session has invoked the cockpit skill at some point in its
 *  life, never undone (#216). **The wrapper element is the whole tell**:
 *  matching a bare `/port:pipeline` substring would also fire on any session
 *  that merely *read* `SKILL.md`, which names that string in its own pacing
 *  section, so this only matches the harness's own expansion wrapper form.
 *  The wrapper's tag name is assembled at runtime rather than written as a
 *  contiguous literal anywhere in this file — a shipped file naming it
 *  directly would itself make any session that merely reads that file look
 *  like a cockpit invocation (see the `preflight-tell-guard` layer 1 check).
 *  Returns `false`, never `null`, for unreadable or empty text — callers
 *  that need "unreadable" distinguished pass that through separately, the
 *  same shape `recentOperatorMessages` uses. */
export function invokedCockpitSkill(jsonlText) {
  if (typeof jsonlText !== 'string' || jsonlText.length === 0) return false;
  const tag = ['command', 'name'].join('-');
  const wrapper = new RegExp(`<${tag}>/?(?:[a-z0-9_-]+:)?pipeline<\\/${tag}>`);
  return wrapper.test(jsonlText);
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
 *  this returns `null` rather than `false`. An empty `numbers` means there is
 *  nothing to verify a name against, so this returns `false` rather than the
 *  vacuously-true result `[].every(...)` would otherwise give — a caller
 *  should prefer checking `gateClearAttempt`'s `hasNumbers` directly so it
 *  can give a specific "no identifier found" reason, but this is the
 *  defense-in-depth backstop if it doesn't. */
export function operatorNamed(numbers, messages) {
  if (messages === null) return null;
  if (numbers.length === 0) return false;
  const namesNumber = (n, message) =>
    new RegExp(`#${n}(?!\\d)`).test(message) || new RegExp(`(?:^|[^\\w])${n}(?!\\w)`).test(message);
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
 *  Rule order for a Bash call: gate → claim → install → branch → loop →
 *  allowlist. Each of the first five returns its own specific reason instead
 *  of falling through to the generic allowlist miss/deny. Gate, claim,
 *  branch, and loop are inert — `allow` immediately — for
 *  `who.isOperatorWorktree`, an `/port:implement` session that must stay
 *  unguarded by the cockpit rules (`plan-agent`/`impl-agent` write the same
 *  labels the claim rule guards, at handoff — a subagent- or
 *  operator-worktree-facing deny there would deadlock the pipeline the
 *  instant a claim is taken). **Install is the one Bash-arm rule that is
 *  not**: an install performed from an `impl-<n>` operator worktree
 *  repoints every session on the machine exactly as one from a dispatched
 *  agent's worktree would, so it is never exempt — and the claim rule's own
 *  write-tool arm (below) matches that same non-exemption, for the same
 *  reason: a machine that can release its own constraint is the #138
 *  failure again.
 *
 *  `needsHumanLabel` and `operatorMessages` are optional: omitting
 *  `needsHumanLabel` skips the gate rule entirely (used by callers with no
 *  gate to guard), and `operatorMessages` is the caller's *already-read*
 *  transcript tail (`recentOperatorMessages`) — `decide` never does I/O
 *  itself. `isCockpitSession` is the same shape (`true`/`false`/`null` —
 *  the caller's already-read `invokedCockpitSkill` result, `null` when the
 *  transcript was unreadable): omitting it skips the branch rule entirely,
 *  matching `needsHumanLabel`'s pattern for a caller with no cockpit rule to
 *  guard.
 *
 *  `planGateClaim` and `planGateLabels` are the same optional-inert shape,
 *  for the claim rule (#206, see `PIPELINE.md` → "External gate claim"):
 *  `planGateClaim` is the caller's already-read, already-classified verdict
 *  (`{state: 'absent'}` / `{state: 'held', owner, scopes, unknownScopes,
 *  claimedAt}` / `{state: 'unreadable', message}` — the same three verdicts
 *  the desktop app's own claim reader returns) and `planGateLabels` the
 *  resolved names for `planReview`/`planApproved`/
 *  `planChangesRequested`. Omitting either skips the rule entirely; a
 *  `state: 'absent'` verdict also does not fire it — nothing is claimed, so
 *  there is nothing to deny. `claimFilePath` (optional, absolute) is the
 *  claim rule's second, write-tool arm: a `Write`/`Edit`/`NotebookEdit`
 *  targeting that exact path is denied for **every** caller, including a
 *  subagent and an `/port:implement` worktree — the cockpit's own
 *  `allowed-tools` already grants it `Write`, so this is the one guard that
 *  keeps it from releasing a claim it did not create. */
export function decide({
  payload,
  matchers,
  sessionRequiredPaths,
  root,
  needsHumanLabel,
  operatorMessages,
  isCockpitSession,
  planGateClaim,
  planGateLabels,
  claimFilePath,
}) {
  const who = callerKind(payload);
  const toolName = payload?.tool_name;

  if (toolName === 'Bash') {
    const command = payload?.tool_input?.command;
    if (typeof command !== 'string' || command.length === 0) {
      return { decision: 'allow', who, subject: null };
    }

    // Gate rule — evaluated first so an unauthorised clear gets its own
    // reason, never the generic allowlist copy.
    //
    // Deliberately not extended to <labels.approved>: the same rail in
    // PIPELINE.md covers it too, but it has no observed violation, and it
    // carries the refresh carve-out (an approved pull request's label set IS
    // allowed to change there), which would need a second predicate this rule
    // does not have. Noted here so the omission reads as a choice, not an
    // oversight.
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
          // No bare digit and no issues|pull URL to key off — e.g. a
          // branch-name form, or `--remove-label` with no identifier at all
          // (`gh` defaults to the current branch's PR). There is nothing to
          // check an operator message against, so this must never fall
          // through to operatorNamed's vacuously-true `[].every(...)`.
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
        // named === true, or null (unverifiable transcript) — allow, and
        // let the caller log this as the audit record for the clear.
        return { decision: 'gate-clear', who, subject: command };
      }
    }

    // Claim rule (#206), Bash arm — a `plan-gate` claim (see `PIPELINE.md` →
    // "External gate claim") transfers the plan-review gate to an external
    // owner; adding or removing any of the three plan-gate labels while a
    // claim holds it (a `held` verdict naming `plan-gate` in its scopes), or
    // while the claim is unreadable (a malformed claim reads as claimed on
    // both sides, since the ambiguity is which writer owns the gate), is
    // denied. A `held` claim naming some *other* scope is not this rule's
    // business — the gate is unclaimed either way. Exempt for a subagent
    // and for `who.isOperatorWorktree`, the same shape the gate rule uses:
    // `plan-agent` writes `planReview` at handoff and removes
    // `planChangesRequested` in revision mode, `impl-agent` removes
    // `planApproved`, and `/port:implement` needs the same exemption for the
    // same reason — a rule that fired there would deadlock the pipeline the
    // moment a claim is taken.
    const claimsPlanGate =
      planGateClaim?.state === 'unreadable' ||
      (planGateClaim?.state === 'held' && (planGateClaim.scopes ?? []).includes('plan-gate'));
    if (claimsPlanGate && planGateLabels && !who.isSubagent && !who.isOperatorWorktree) {
      const attempt = labelEditAttempt(command, planGateLabels);
      if (attempt.isAttempt) {
        const names = attempt.matched.join(', ');
        const owner =
          planGateClaim.state === 'held'
            ? `claimed by "${planGateClaim.owner}"`
            : `unreadable (${planGateClaim.message})`;
        return {
          decision: 'deny',
          who,
          subject: command,
          reason: `port: the plan gate is ${owner} — ${names} is denied until the claim is released. Release it in the app, or delete .agents/gate-claim.json, to take the gate back.`,
        };
      }
    }

    // Install rule (#144) — every install scope resolves to one shared
    // `installPath`, so a `claude plugin install`/`marketplace add` (or the
    // uninstall/remove forms, which repoint the same way on the next
    // install) run from inside a managed worktree silently repoints every
    // session on the machine, and keeps doing so after that worktree is
    // gone. Deliberately the one cockpit-class rule that does **not** exempt
    // `who.isOperatorWorktree` — an `/port:implement` worktree is isolated
    // for everything else, but an install specifically is not, and the
    // blast radius is identical whether the operator or a dispatched agent
    // typed it.
    if (who.isManagedWorktree && pluginInstallMutation(command)) {
      return {
        decision: 'deny',
        who,
        subject: command,
        reason:
          'port: installing, uninstalling, or changing a plugin marketplace from inside a managed worktree is denied — every install scope shares one installPath, so this would silently repoint every session on the machine and keep doing so after this worktree is gone. Run it from the main checkout instead.',
      };
    }

    // Branch rule (#216) — a cockpit session `git checkout`/`git switch`ing
    // out from under its own startup refusal ("check one of those out and
    // start me again" is not an instruction to change branches itself).
    // `isCockpitSession === null` (transcript unreadable) allows, matching
    // the gate rule: an unknowable identity is not an established cockpit.
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

    if (matchers === null) {
      return { decision: 'allow', who, subject: command };
    }
    // #205: an absolute in-repo invocation (worktree or base checkout) is the
    // same command as its repo-relative allowlisted form — resolved here, at
    // the miss, so a logged deny/miss still shows what the agent actually
    // typed rather than a rewritten stand-in.
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

    // Claim rule (#206), write-tool arm — denied for every caller, including
    // a subagent and an /port:implement impl-<n> worktree: unlike the Bash
    // arm above, this one has no exemption, because releasing the claim
    // file is exactly the #138 shape (a machine undoing its own
    // constraint) regardless of who is asking. Runs before the ordinary
    // non-subagent early return below, which would otherwise let a plain
    // session's write straight through.
    if (claimFilePath && typeof filePath === 'string' && filePath.length > 0 && resolve(root, filePath) === claimFilePath) {
      return {
        decision: 'deny',
        who,
        subject: filePath,
        reason:
          'port: .agents/gate-claim.json is created and released only by an explicit operator action in the app — no session or agent may write to it, including from an operator worktree. Release a claim in the app instead.',
      };
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
