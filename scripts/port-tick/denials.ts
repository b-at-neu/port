// Pure: classifies new `.agents/denials.log` lines into the delta counts
// `plan` stamps on its `tick` record, per plugins/port/docs/PIPELINE.md →
// "Denial visibility". The offset read itself — where the previous line
// count left off — stays in the caller (port-tick.ts), which already owns
// `tickState.denialsConsumed`; this module never touches the filesystem.

/** The closed set the guard hook (`hooks/agent-guard.mjs`) actually writes,
 *  pinned three ways by scripts/checks/tick.ts: against the hook's own
 *  `log()` call sites and against apps/desktop's `CURRENT_DECISIONS`, both
 *  directions. A decision outside this set is `unknown`, never silently
 *  folded into `deny` — docs/ENGINEERING.md §4: an absent or unrecognized
 *  signal is never read as a known one. */
export const DENIAL_DECISIONS = new Set(['deny', 'miss', 'gate-clear', 'hook-error']);

/** Parses one denials.log line into its four tab-separated fields
 *  (`<iso8601>` `<decision>` `<who>` `<command-or-path>`). Fewer than two
 *  fields → `{ malformed: true }`. A decision outside `DENIAL_DECISIONS` →
 *  `{ unknown: true, ... }`, counted separately, never as `deny`. */
export function parseDenialLine(line: string): any {
  const fields = line.split('\t');
  if (fields.length < 2) return { malformed: true };
  const [timestamp, decision, actor = '', ...rest] = fields;
  const subject = rest.join('\t');
  if (!DENIAL_DECISIONS.has(decision)) {
    return { malformed: false, unknown: true, timestamp, decision, actor, subject };
  }
  return { malformed: false, unknown: false, timestamp, decision, actor, subject };
}

/** Summarizes a batch of already-read new lines (the delta since the last
 *  offset) into the counts the `tick` record carries. `railDeny` is a `deny`
 *  whose actor starts with `session:` — this session's own rail holding,
 *  never a missing permission (PIPELINE.md → "Denial visibility") — split
 *  off `deny`, never folded into it. Blank lines (a trailing newline's
 *  artifact) are skipped and never counted as `newLines`. */
export function summarizeDelta(lines: string[]): any {
  const out = { newLines: 0, deny: 0, railDeny: 0, miss: 0, gateClear: 0, hookError: 0, unknown: 0, malformed: 0 };
  for (const raw of lines) {
    if (raw === '') continue;
    out.newLines += 1;
    const parsed = parseDenialLine(raw);
    if (parsed.malformed) {
      out.malformed += 1;
      continue;
    }
    if (parsed.unknown) {
      out.unknown += 1;
      continue;
    }
    if (parsed.decision === 'deny') {
      if (parsed.actor.startsWith('session:')) out.railDeny += 1;
      else out.deny += 1;
    } else if (parsed.decision === 'miss') {
      out.miss += 1;
    } else if (parsed.decision === 'gate-clear') {
      out.gateClear += 1;
    } else if (parsed.decision === 'hook-error') {
      out.hookError += 1;
    }
  }
  return out;
}
