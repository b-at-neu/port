// Pure: classifies new `.agents/denials.log` lines into the delta counts `plan` stamps on its
// `tick` record. The offset read stays in the caller; this module never touches the filesystem.

/** The closed set the guard hook actually writes, pinned against its `log()` call sites and
 *  apps/desktop's `CURRENT_DECISIONS`. A decision outside this set is `unknown`, never silently folded into `deny`. */
export const DENIAL_DECISIONS = new Set(['deny', 'miss', 'gate-clear', 'hook-error']);

/** Parses one denials.log line into its four tab-separated fields. Fewer than two fields →
 *  `{ malformed: true }`; a decision outside `DENIAL_DECISIONS` → `{ unknown: true, ... }`. */
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

/** Summarizes a batch of new lines into the counts the `tick` record carries. `railDeny` is a
 *  `deny` whose actor starts with `session:`, split off `deny`. Blank lines are skipped. */
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
