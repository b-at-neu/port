// Dependency-free JSONL parsing and record classification (#123) —
// scripts/'s only reader of a Claude Code transcript. Pure: no `node:fs`,
// no child process, nothing but string and array operations, so every
// export here is directly unit-testable against
// scripts/port-forensics/cases/transcript.cases.json.
//
// Behaviourally pinned, for the record-classification and tool-call-pairing
// slice both sides share, against apps/desktop/src/main/sessions/
// transcript-entries.ts's own `createDeriver` — via the shared case table
// apps/desktop/src/main/sessions/transcript.cases.json
// (scripts/checks/forensics.ts runs this module against it;
// transcript-entries.test.ts runs the desktop deriver against the same
// file) — so scripts/port-forensics/ and the desktop app can never silently
// disagree about what a record means (docs/ENGINEERING.md §2).
//
// Every transcript byte is untrusted data (the ticket's own "Two hard
// constraints"): parsed and classified here, never interpreted as
// instructions and never executed.

const CONTROL_RANGES = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
];

const BIDI_RANGES = [
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];

function isInRanges(codePoint: number, ranges: number[][]): boolean {
  return ranges.some(([start, end]) => codePoint >= start && codePoint <= end);
}

/** Strips C0/C1 control characters (tab/newline excepted) and bidi override
 *  characters — the same ranges apps/desktop's own `sanitize` strips, so a
 *  transcript's untrusted bytes can never inject a terminal escape or
 *  reverse how a finding reads in the operator's console. */
export function sanitize(text: string): string {
  let out = '';
  for (const ch of text) {
    const codePoint = ch.codePointAt(0) ?? 0;
    if (isInRanges(codePoint, CONTROL_RANGES) || isInRanges(codePoint, BIDI_RANGES)) continue;
    out += ch;
  }
  return out;
}

const EXCERPT_CAP = 200;

/** The one chokepoint for transcript-derived text reaching a finding: sanitize,
 *  then cap at `cap` (default 200) characters, with an `omittedChars` count.
 *  Nothing else under scripts/port-forensics/ may print record-derived text —
 *  scripts/checks/forensics.ts pins that mechanically. */
export function excerpt(text: string | null | undefined, cap = EXCERPT_CAP): { text: string; omittedChars: number } {
  const sanitized = sanitize(text ?? '');
  if (sanitized.length <= cap) return { text: sanitized, omittedChars: 0 };
  return { text: sanitized.slice(0, cap), omittedChars: sanitized.length - cap };
}

/** JSONL text -> parsed records, never throwing. A line that fails to parse
 *  is counted in `malformed`, never dropped silently — the count is a
 *  findings-report fact, not swallowed. Blank lines are skipped without
 *  counting, matching apps/desktop's own `parseLines`. */
export function parseLines(text: string): { records: any[]; malformed: number } {
  const records: any[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed };
}

function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One already-parsed JSONL record -> zero or more generic events, in the
 *  vocabulary apps/desktop's own `TranscriptEntry` kinds already use
 *  (`user-text`/`assistant-text`/`thinking`/`tool-use`/`tool-result`/`meta`).
 *  Unrecognizable content (missing `uuid`/`timestamp`, an unknown block
 *  type) is skipped, never thrown on — a transcript is untrusted input from
 *  disk, the same contract `parseLines` holds for a line that is not even
 *  valid JSON. */
export function classifyRecord(raw: any): any[] {
  if (!isPlainObject(raw)) return [];
  const { uuid, timestamp } = raw;
  if (typeof uuid !== 'string' || typeof timestamp !== 'string') return [];

  if (raw.type === 'attachment') {
    return [{ kind: 'meta', uuid, timestamp, attachment: raw.attachment ?? null }];
  }

  const message = raw.message;
  if (!isPlainObject(message)) return [];
  const role = message.role;
  const content = message.content;

  if (typeof content === 'string') {
    if (role === 'user') return [{ kind: 'user-text', uuid, timestamp, text: content }];
    if (role === 'assistant') return [{ kind: 'assistant-text', uuid, timestamp, text: content }];
    return [];
  }
  if (!Array.isArray(content)) return [];

  const events = [];
  for (const block of content) {
    if (!isPlainObject(block)) continue;
    const type = block.type;
    if (type === 'text' && typeof block.text === 'string') {
      events.push({ kind: role === 'user' ? 'user-text' : 'assistant-text', uuid, timestamp, text: block.text });
    } else if (type === 'thinking' && typeof block.thinking === 'string') {
      events.push({ kind: 'thinking', uuid, timestamp, text: block.thinking });
    } else if (type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      events.push({ kind: 'tool-use', uuid, timestamp, id: block.id, name: block.name, input: block.input });
    } else if (type === 'tool_result' && typeof block.tool_use_id === 'string') {
      events.push({
        kind: 'tool-result',
        uuid,
        timestamp,
        id: block.tool_use_id,
        isError: block.is_error === true,
        content: block.content,
      });
    }
    // Any other block type (redacted_thinking, an image, ...) is skipped —
    // not this module's concern; forensics never renders tool payloads.
  }
  return events;
}

function resultTextOf(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (isPlainObject(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/** Folds a flat, ordered list of already-classified events (`classifyRecord`)
 *  into `{ emitted, paired }` — `tool-use` and the `tool-result` that later
 *  carries its id pair by id, never by position, first-result-wins (a
 *  duplicate `tool_result` for the same id is a no-op), the exact contract
 *  apps/desktop's own `createDeriver` implements independently. Order-only:
 *  concatenating what were originally separate reads produces the same
 *  result as reading them in one pass, since pairing has no batch boundary
 *  of its own — which is what lets a whole-file read (this module's use)
 *  and a streamed, chunked read (the desktop app's) agree. */
export function pairToolResults(events: any[]): { emitted: any[]; paired: any[] } {
  const emitted: any[] = [];
  const pendingIndexById = new Map<string, number>();
  const resultById = new Map<string, any>();

  for (const ev of events) {
    if (ev.kind === 'tool-use') {
      pendingIndexById.set(ev.id, emitted.length);
      emitted.push({ kind: 'tool-call', name: ev.name, input: ev.input, id: ev.id });
      continue;
    }
    if (ev.kind === 'tool-result') {
      if (resultById.has(ev.id)) continue; // duplicate result — no-op
      if (!pendingIndexById.has(ev.id)) continue; // result with no matching call in this stream
      resultById.set(ev.id, { isError: ev.isError, text: resultTextOf(ev.content) });
      continue;
    }
    emitted.push({ kind: ev.kind, text: ev.text ?? null, attachment: ev.attachment ?? null });
  }

  const paired: any[] = [];
  emitted.forEach((entry, index) => {
    if (entry.kind !== 'tool-call') return;
    const result = resultById.get(entry.id);
    if (result) paired.push({ index, isError: result.isError, text: result.text });
  });

  return { emitted, paired };
}

/** The whole-session convenience: already-parsed records -> `{ emitted,
 *  paired }`, in one call. `scan.ts` is the only caller that reads a file;
 *  this stays pure. */
export function deriveEvents(records: any[]): { emitted: any[]; paired: any[] } {
  return pairToolResults(records.flatMap((r) => classifyRecord(r)));
}
