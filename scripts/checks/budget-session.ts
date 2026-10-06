import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// bin/budget.mjs's --session support: one session log per dispatcher, so one dispatcher's
// sweep never closes rows another's agents are still working through.
export default async function ({ expect, fail, ok }: Reporter) {
  const scriptRel = 'plugins/port/bin/budget.mjs';
  const scriptPath = join(root, scriptRel);
  const scriptText = readFileSync(scriptPath, 'utf8');

  const mod = await import(pathToFileURL(scriptPath).href);
  const { sessionLogName } = mod;

  // --- sessionLogName: the absent/valid/invalid cases — a malformed --session must never silently share the default session's file. ---
  {
    const cases: [string | undefined, string | null][] = [
      [undefined, 'budget-session.tsv'],
      ['desktop', 'budget-session-desktop.tsv'],
      ['', null],
      ['A', null], // must start with a lowercase letter
      ['../x', null],
      ['a'.repeat(33), null], // one past the 32-character ceiling
      ['a'.repeat(32), 'budget-session-' + 'a'.repeat(32) + '.tsv'], // exactly at the ceiling
    ];
    for (const [input, want] of cases) {
      const got = sessionLogName(input);
      expect(!(got !== want), 'budget-session-name', `sessionLogName(${JSON.stringify(input)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    }
  }

  // --- reset/sweep/dispatch each accept --session — one mode missing it would silently share the default session log. ---
  {
    const modes: { name: string; fn: string }[] = [
      { name: 'reset', fn: 'function runReset(' },
      { name: 'sweep', fn: 'function runSweep(' },
      { name: 'dispatch', fn: 'function runDispatch(' },
    ];
    for (const mode of modes) {
      const start = scriptText.indexOf(mode.fn);
      if (start === -1) {
        fail('budget-session-cli', `${scriptRel} no longer defines ${mode.fn}`);
        continue;
      }
      const body = scriptText.slice(start, scriptText.indexOf('\n}', start));
      expect(body.includes("'--session'"), 'budget-session-cli', `${scriptRel}'s ${mode.name} mode never lists '--session' in its parseCommonArgs spec`);
    }
  }
}
