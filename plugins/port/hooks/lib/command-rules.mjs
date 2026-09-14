// Pure command-syntax predicates for the agent-guard PreToolUse hook.
//
// Split out of guard-rules.mjs (#216) — that file was at 483/500 lines and
// adding the branch rule (#216) would have crossed the ceiling. This module
// holds every predicate that reasons about a command string's shell syntax
// alone, with no caller identity or transcript I/O; guard-rules.mjs keeps
// `callerKind`, `allowMatchers` and the rest of the settings/transcript
// readers, plus `decide` itself.

/** Tokenizes a shell command, respecting single/double quotes — a quoted
 *  span's contents (spaces included) become one token, so a flag value like
 *  `"needs human"` is not split in two. */
export function tokenize(command) {
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
export function atCommandPosition(text, keyword) {
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

/** True if `command` (already quote-stripped by the caller) invokes a
 *  `claude plugin` mutation that changes what a shared `installPath`
 *  resolves to: `install`, `uninstall`, `marketplace add`, or `marketplace
 *  remove`. Read-only subcommands (`list`, `details`, ...) are deliberately
 *  not matched. */
export function pluginInstallMutation(command) {
  const stripped = stripQuoted(command);
  if (!atCommandPosition(stripped, 'claude')) return false;
  const tokens = tokenize(stripped);
  const claudeIdx = tokens.indexOf('claude');
  if (claudeIdx === -1 || tokens[claudeIdx + 1] !== 'plugin') return false;
  const sub = tokens[claudeIdx + 2];
  if (sub === 'install' || sub === 'uninstall') return true;
  if (sub === 'marketplace' && (tokens[claudeIdx + 3] === 'add' || tokens[claudeIdx + 3] === 'remove')) return true;
  return false;
}

// `git` global options that consume the *next* token as a separate value —
// `-c core.editor=true`, `-C /path`, `--git-dir <path>`, and so on — as
// opposed to a boolean flag or one whose value is glued on with `=`. Missing
// one of these means the loop below treats that value token as the git
// subcommand itself and gives up right there, never reaching the real
// subcommand a few tokens later (#222, R3-M1).
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix']);

/** True when `command` (quote-stripped internally) invokes `git
 *  checkout`/`git switch`, plain or via `git -C <path> checkout` — the
 *  escape #216 recorded a cockpit session taking to get around its own
 *  startup refusal. Deliberately coarse: inside a cockpit session it fails
 *  toward **denying**, since that session's own `allowed-tools` grants it
 *  only `git rev-parse`/`branch`/`cat-file` in the first place, so a false
 *  deny costs the cockpit nothing it is supposed to do, while a false allow
 *  is exactly the escape this rule exists to close. */
export function switchesBranch(command) {
  const stripped = stripQuoted(command);
  // Every command-position `git` occurrence, not just the first — the same
  // shape `usesShellLoop`/`targetsGhOrGit` scan for their own keywords, since
  // a chained command can carry an earlier, unrelated `git` invocation ahead
  // of the checkout (e.g. `git branch --sort=... ; git checkout evil-branch`).
  // Uses the same raw-text command-position regex `atCommandPosition` tests
  // with, run with `g` so every occurrence is visited, since token-splitting
  // alone would miss a separator glued to `git` with no surrounding space
  // (`...;git checkout`).
  const gitAtCommandPosition = /(?:^|[\s;&|(])git(?=[\s;&|)]|$)/g;
  let match;
  while ((match = gitAtCommandPosition.exec(stripped))) {
    const rest = stripped.slice(match.index + match[0].length);
    const tokens = tokenize(rest);
    for (let i = 0; i < tokens.length; i++) {
      if (GIT_VALUE_FLAGS.has(tokens[i])) {
        i++; // skip the flag's own separate value argument
        continue;
      }
      if (tokens[i].startsWith('-')) continue; // any other git-level flag
      if (tokens[i] === 'checkout' || tokens[i] === 'switch') return true;
      break;
    }
  }
  return false;
}

/** Detects a `gh pr edit`/`gh issue edit` call that removes `label`, and the
 *  item numbers it targets — a bare positional digit, or the trailing digits
 *  of a `github.com/**\/(issues|pull)/<n>` URL. Quote-aware, so a label name
 *  with spaces (`"needs human"`) is read correctly. `numbers` is always
 *  collected, even when `isAttempt` is false, so a caller never re-tokenizes.
 *  `hasNumbers` is `false` whenever `gh` was given no digit and no
 *  `issues|pull` URL to key off — e.g. `gh pr edit <branch-name> ...` or
 *  `gh pr edit --remove-label ...` with no identifier at all, which `gh`
 *  accepts as "the current branch's PR". A caller must not treat an empty
 *  `numbers` array as "nothing to verify": `[].every(...)` is vacuously
 *  `true`, so skipping this check would let an unidentified item's gate
 *  clear through with nothing for the operator to have named. */
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
  const hasNumbers = numbers.length > 0;

  if (!isEdit) return { isAttempt: false, numbers, hasNumbers };

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

  return { isAttempt, numbers, hasNumbers };
}
