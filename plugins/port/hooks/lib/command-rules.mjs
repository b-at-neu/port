// Pure command-syntax predicates for the agent-guard PreToolUse hook — every predicate that
// reasons about a command string's shell syntax alone, with no caller identity or transcript I/O.

/** Tokenizes a shell command, respecting single/double quotes — a quoted span's contents
 *  become one token, so a flag value like `"needs human"` is not split in two. */
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

/** True if `text` carries `keyword` at a shell command position and a word boundary — keeps
 *  `github` from matching `gh` and a `for` inside a longer identifier from matching the loop keyword. */
export function atCommandPosition(text, keyword) {
  const re = new RegExp(`(?:^|[\\s;&|(])${keyword}(?=[\\s;&|)]|$)`);
  return re.test(text);
}

/** Replaces every quoted span's contents with nothing, so every syntactic test below runs on
 *  shell structure only, never flag-argument contents. */
export function stripQuoted(command) {
  return command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

/** A `for`/`while`/`until` keyword and a `do` keyword, each at a command position, on the
 *  quote-stripped command. */
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

/** True if `command` invokes a `claude plugin` mutation that changes what a shared
 *  `installPath` resolves to: install/uninstall/marketplace add/marketplace remove. */
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

// `git` global options that consume the next token as a separate value (`-C /path`, etc) —
// missing one means the loop below treats that value as the subcommand itself and gives up.
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix']);

/** True when `command` invokes `git checkout`/`git switch`, plain or via `git -C <path>
 *  checkout` — closes a cockpit-session escape from its own startup refusal. */
export function switchesBranch(command) {
  const stripped = stripQuoted(command);
  // Every command-position `git` occurrence, not just the first, since a chained command can
  // carry an earlier, unrelated `git` invocation ahead of the checkout.
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

/** True when `tokens[0..2]` spell `gh pr edit` or `gh issue edit` — the one
 *  test both `gateClearAttempt` and `labelEditAttempt` share. */
function isGhLabelEdit(tokens) {
  return (
    tokens[0] === 'gh' &&
    ((tokens[1] === 'pr' && tokens[2] === 'edit') || (tokens[1] === 'issue' && tokens[2] === 'edit'))
  );
}

/** The item numbers a `gh pr edit`/`gh issue edit` call targets: a bare digit, an issue/pull
 *  URL's trailing digits, or (`pr edit` only) a branch selector's leading `N-`. */
function commandNumbers(tokens) {
  const numbers = [];
  const isPrEdit = tokens[0] === 'gh' && tokens[1] === 'pr' && tokens[2] === 'edit';
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const prev = tokens[i - 1] ?? '';
    if (prev.startsWith('-')) continue; // a flag's value, not a positional item number
    if (/^\d+$/.test(t)) {
      numbers.push(Number(t));
      continue;
    }
    const m = /\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/.exec(t);
    if (m) {
      numbers.push(Number(m[1]));
      continue;
    }
    if (isPrEdit) {
      const b = /^(\d+)-[\w./-]+$/.exec(t);
      if (b) numbers.push(Number(b[1]));
    }
  }
  return numbers;
}

/** Every value `flag` (spaced or `=`-glued) carries on `tokens`, comma-split, trimmed, lower-cased. */
function flagValues(tokens, flag) {
  const values = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let value = null;
    if (t === flag) value = tokens[i + 1] ?? '';
    else if (t.startsWith(`${flag}=`)) value = t.slice(flag.length + 1);
    if (value === null) continue;
    values.push(...value.split(',').map((v) => v.trim().toLowerCase()));
  }
  return values;
}

/** Detects a `gh pr edit`/`gh issue edit` call that removes `label`, and the item numbers it
 *  targets. An empty `numbers` must never be treated as "nothing to verify". */
export function gateClearAttempt(command, label) {
  const tokens = tokenize(command);
  const isEdit = isGhLabelEdit(tokens);
  const numbers = commandNumbers(tokens);
  const hasNumbers = numbers.length > 0;

  if (!isEdit) return { isAttempt: false, numbers, hasNumbers };

  const target = label.trim().toLowerCase();
  const isAttempt = flagValues(tokens, '--remove-label').includes(target);

  return { isAttempt, numbers, hasNumbers };
}

/** Detects a `gh pr edit`/`gh issue edit` call whose `--add-label`/`--remove-label` value
 *  set intersects `names`, matched case-insensitively — unlike `gateClearAttempt`'s remove-only. */
export function labelEditAttempt(command, names) {
  const tokens = tokenize(command);
  const isEdit = isGhLabelEdit(tokens);
  const numbers = commandNumbers(tokens);
  const hasNumbers = numbers.length > 0;

  if (!isEdit) return { isAttempt: false, matched: [], numbers, hasNumbers };

  const touched = new Set([...flagValues(tokens, '--add-label'), ...flagValues(tokens, '--remove-label')]);
  const matched = [...names].filter((name) => touched.has(name.trim().toLowerCase()));

  return { isAttempt: matched.length > 0, matched, numbers, hasNumbers };
}
