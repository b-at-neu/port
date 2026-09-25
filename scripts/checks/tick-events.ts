// Layer 1 checks for the trajectory record (#187) — split out of
// scripts/checks/tick.ts, which is already near the 500-line ratchet
// (docs/ENGINEERING.md §7): the write-only rail, the envelope contract, the
// denial-decision vocabulary pinned three ways, and the retention literal.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

const TICK_DIR = 'scripts/port-tick';

async function importEngine(rel: string): Promise<any> {
  return import(pathToFileURL(join(root, rel)).href);
}

/** Extracts every `'<decision>'` string literal passed as `log()`'s second
 *  positional argument in `agent-guard.mjs`, tracking paren depth (never a
 *  flat regex) so a first argument carrying its own nested call and comma —
 *  `log(join(baseRepoRoot(cwd), '.agents'), 'hook-error', ...)` — still
 *  splits on the right comma. */
function extractLogDecisions(text: string): Set<string> {
  const decisions = new Set<string>();
  const callRe = /\blog\(/g;
  let call;
  while ((call = callRe.exec(text))) {
    let i = call.index + call[0].length;
    let depth = 1;
    let arg = '';
    const args = [];
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          args.push(arg);
          break;
        }
      } else if (ch === ',' && depth === 1) {
        args.push(arg);
        arg = '';
        i++;
        continue;
      }
      arg += ch;
      i++;
    }
    const m = /^\s*'([a-z-]+)'\s*$/.exec(args[1] ?? '');
    if (m) decisions.add(m[1]);
  }
  return decisions;
}

export default async function ({ fail, ok }: Reporter) {
  // --- Write-only rail: nothing but port-tick.ts and report.ts itself may
  // import events.ts or report.ts, and events.ts exports no reader.
  // guard(#187, #203): an append-only history feeding a future tick's
  // decision, quietly breaking the invariant that `plan` never persists
  // anything a later tick reads back.
  {
    const eventsPath = join(root, TICK_DIR, 'events.ts');
    const reportPath = join(root, TICK_DIR, 'report.ts');
    const portTickPath = join(root, 'scripts/port-tick.ts');
    const importRe = /from\s+['"]\.\/(events|report)\.ts['"]/;
    const files = [portTickPath, ...walk(join(root, TICK_DIR)).filter((f) => f.endsWith('.ts'))];
    for (const f of files) {
      if (f === eventsPath || f === reportPath || f === portTickPath) continue;
      const text = readFileSync(f, 'utf8');
      const m = importRe.exec(text);
      if (m) fail('tick-events', `${relOf(f)} imports ${m[1]}.ts — only port-tick.ts and report.ts itself may read the trajectory record`);
      else ok();
    }
    const eventsExports = [...readFileSync(eventsPath, 'utf8').matchAll(/export function (\w+)\(/g)].map((m) => m[1]);
    for (const name of eventsExports) {
      if (/read|parse/i.test(name)) fail('tick-events', `events.ts exports '${name}' — a read/parse-named export is exactly what the write-only rail forbids`);
      else ok();
    }
  }

  // --- Envelope contract: formatEvent's output parses as JSON, carries the
  // full envelope, has no raw newline, and caps at 8KB with truncated:true.
  {
    const { formatEvent } = await importEngine(`${TICK_DIR}/events.ts`);
    const small = formatEvent({ v: 1, ts: 't', runId: 'r', repo: 'o/n', kind: 'tick' }, { a: 1 });
    let parsedSmall;
    try {
      parsedSmall = JSON.parse(small);
    } catch {
      parsedSmall = null;
    }
    if (!parsedSmall || !('v' in parsedSmall) || !('ts' in parsedSmall) || !('runId' in parsedSmall) || !('repo' in parsedSmall) || !('kind' in parsedSmall)) {
      fail('tick-events', 'formatEvent output does not parse as JSON carrying v/ts/runId/repo/kind');
    } else if (small.includes('\n')) {
      fail('tick-events', 'formatEvent output contains a raw newline — a single line must never split');
    } else {
      ok();
    }
    const bigArray = Array.from({ length: 5000 }, (_, i) => ({ item: i, stage: 'impl-agent' }));
    const big = formatEvent({ v: 1, ts: 't', runId: 'r', repo: 'o/n', kind: 'tick' }, { liveItems: bigArray });
    const bigParsed = JSON.parse(big);
    if (Buffer.byteLength(big, 'utf8') > 8 * 1024) fail('tick-events', `formatEvent did not cap an oversized payload at 8KB (got ${Buffer.byteLength(big, 'utf8')} bytes)`);
    else if (bigParsed.truncated !== true) fail('tick-events', 'formatEvent capped an oversized payload but never stamped truncated: true');
    else ok();
  }

  // --- Decision vocabulary pinned three ways: DENIAL_DECISIONS equals the
  // literals hooks/agent-guard.mjs passes to log(), and equals the desktop's
  // CURRENT_DECISIONS, both directions.
  {
    const { DENIAL_DECISIONS } = await importEngine(`${TICK_DIR}/denials.ts`);
    const hookText = readFileSync(join(root, 'plugins/port/hooks/agent-guard.mjs'), 'utf8');
    const hookDecisions = extractLogDecisions(hookText);
    for (const d of hookDecisions) {
      if (!DENIAL_DECISIONS.has(d)) fail('tick-events', `agent-guard.mjs logs decision '${d}', which denials.ts's DENIAL_DECISIONS does not carry`);
      else ok();
    }
    for (const d of DENIAL_DECISIONS) {
      if (!hookDecisions.has(d)) fail('tick-events', `denials.ts's DENIAL_DECISIONS carries '${d}', which agent-guard.mjs never logs`);
      else ok();
    }
    const desktopText = readFileSync(join(root, 'apps/desktop/src/main/local/denials.ts'), 'utf8');
    const desktopMatch = /CURRENT_DECISIONS[^=]*=\s*new Set\(\[([^\]]+)\]\)/.exec(desktopText);
    const desktopDecisions = new Set((desktopMatch?.[1].match(/'([a-z-]+)'/g) ?? []).map((s) => s.slice(1, -1)));
    for (const d of desktopDecisions) {
      if (!DENIAL_DECISIONS.has(d)) fail('tick-events', `desktop's CURRENT_DECISIONS carries '${d}', which denials.ts's DENIAL_DECISIONS does not`);
      else ok();
    }
    for (const d of DENIAL_DECISIONS) {
      if (!desktopDecisions.has(d)) fail('tick-events', `denials.ts's DENIAL_DECISIONS carries '${d}', which desktop's CURRENT_DECISIONS does not`);
      else ok();
    }
  }

  // --- Retention: the 8MB rotation cap is a literal, never a guess. -------
  {
    const eventsText = readFileSync(join(root, TICK_DIR, 'events.ts'), 'utf8');
    if (!eventsText.includes('8 * 1024 * 1024')) fail('tick-events', 'events.ts is missing the literal 8MB rotation cap');
    else ok();
  }
}
