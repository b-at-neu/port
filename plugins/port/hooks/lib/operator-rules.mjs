// Operator-transcript predicates for the agent-guard PreToolUse hook.
//
// Split out of guard-rules.mjs (#288) — that file was at 486/500 lines and
// the approval arm needed room the ceiling did not have. This module holds
// the two functions that read a session transcript's operator (human)
// messages and test whether they name a set of item numbers; guard-rules.mjs
// keeps `callerKind`, `allowMatchers`, `invokedCockpitSkill`, and `decide`
// itself, importing these two back in unchanged. Moved verbatim, docblocks
// included — no behaviour change, only location.

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
