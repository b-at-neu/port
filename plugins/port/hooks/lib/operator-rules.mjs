// Operator-transcript predicates for the agent-guard PreToolUse hook: reads a session
// transcript's operator (human) messages and tests whether they name a set of item numbers.

/** The last `limit` operator (human) messages in a session transcript's JSONL text, oldest
 *  first, dropping harness wrapper texts. Returns `null` when nothing parseable exists at all. */
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

/** True when every number is named in some message, as `#N` or standalone. `null` messages
 *  means unreadable; empty `numbers` returns `false`, never the vacuously-true `[].every(...)`. */
export function operatorNamed(numbers, messages) {
  if (messages === null) return null;
  if (numbers.length === 0) return false;
  const namesNumber = (n, message) =>
    new RegExp(`#${n}(?!\\d)`).test(message) || new RegExp(`(?:^|[^\\w])${n}(?!\\w)`).test(message);
  return numbers.every((n) => messages.some((m) => namesNumber(n, m)));
}
