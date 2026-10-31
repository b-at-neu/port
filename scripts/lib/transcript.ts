// Dependency-free JSONL parsing and record classification — scripts/'s only reader of a
// transcript. Pure, pinned against apps/desktop's `createDeriver` via a shared case table.

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

/** Strips C0/C1 control characters (tab/newline excepted) and bidi override characters, so
 *  untrusted bytes can never inject a terminal escape or reverse how a finding reads. */
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

/** The one chokepoint for transcript-derived text reaching a finding: sanitize, then cap.
 *  Nothing else under scripts/port-forensics/ may print record-derived text. */
export function excerpt(text: string | null | undefined, cap = EXCERPT_CAP): { text: string; omittedChars: number } {
  const sanitized = sanitize(text ?? '');
  if (sanitized.length <= cap) return { text: sanitized, omittedChars: 0 };
  return { text: sanitized.slice(0, cap), omittedChars: sanitized.length - cap };
}

/** JSONL text -> parsed records, never throwing. A line that fails to parse is counted in
 *  `malformed`, never dropped silently. Blank lines are skipped without counting. */
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

/** One already-parsed JSONL record -> zero or more generic events, in apps/desktop's own
 *  `TranscriptEntry` vocabulary. Unrecognizable content is skipped, never thrown on. */
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
    // Any other block type is skipped — forensics never renders tool payloads.
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

/** Folds classified events into `{ emitted, paired }` — `tool-use`/`tool-result` pair by id,
 *  never by position, first-result-wins. Order-only, so a whole-file read and a streamed one agree. */
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

/** The whole-session convenience: already-parsed records -> `{ emitted, paired }`, in one call. */
export function deriveEvents(records: any[]): { emitted: any[]; paired: any[] } {
  return pairToolResults(records.flatMap((r) => classifyRecord(r)));
}
