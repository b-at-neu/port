import { pipelineSkillText } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// The tick query, pacing ladder, busy-wait, and ownership/blind-tick blocks.
export default async function ({ expect, fail, ok }: Reporter) {
  const rel = 'plugins/port/skills/pipeline/*.md';

  // --- Collapsed tick query — one round trip, never a per-label poll: the Configuration
  // section's illustrative `--label <unknown>` mention is correctly exempt. ---
  {
    const text = pipelineSkillText();

    for (const phrase of ['gh api graphql', '--include', '.temp/tick-state.md']) {
      expect(text.includes(phrase), 'tick-query', `${rel} never names '${phrase}' — the collapsed tick contract is missing a piece`);
    }

    // Scans the whole union, since the Tick procedure is split across two files and a
    // per-label poll creeping into either is equally a regression.
    const pollRe = /gh (?:issue|pr) list[^\n]*--label(?!\s*<unknown>)/g;
    const hits = [...text.matchAll(pollRe)];
    expect(
      !(hits.length > 0),
      'tick-query',
      () => `${rel}'s tick procedure still issues a per-label poll (${JSON.stringify(hits[0][0])}) — the collapse must fold it into the one query`,
    );
  }

  // --- Pacing ladder — reset-on-change and never-stop are checkable, not prose: the
  // ladder's constants and its two preconditions must stay literal, checkable phrases. ---
  {
    const text = pipelineSkillText();

    for (const n of ['270', '540', '1080', '1800']) {
      expect(text.includes(n), 'pacing-ladder', `${rel} is missing the ladder constant '${n}'`);
    }

    expect(text.includes('Reset to the floor immediately on any observed change'), 'pacing-ladder', `${rel} is missing the literal reset-on-change phrase 'Reset to the floor immediately on any observed change'`);

    expect(text.includes('Never stop — a stopped cockpit is the only dispatcher'), 'pacing-ladder', `${rel} is missing the literal never-stop phrase 'Never stop — a stopped cockpit is the only dispatcher'`);
  }

  // --- No busy-waiting in the cockpit skill: never block a turn on sleep/--watch instead of letting the next scheduled tick do the waiting. ---
  {
    const text = pipelineSkillText();
    expect(!/\bsleep\s+\d/.test(text), 'no-busy-wait', `${rel} contains a 'sleep <n>'-shaped busy-wait — the next tick is how this cockpit waits`);
  }

  // --- Ownership enforced client-side, and the blind-tick contract: a failed collapsed
  // query must never be read as an empty, all-clear tick. ---
  {
    const text = pipelineSkillText();

    expect(text.includes('never acted on, only reported'), 'tick-query', `${rel} is missing the literal client-side ownership precondition phrase 'never acted on, only reported'`);

    expect(text.includes('dispatch nothing, run no hygiene, reset nothing'), 'tick-query', `${rel} is missing the literal blind-tick precondition phrase 'dispatch nothing, run no hygiene, reset nothing'`);
  }
}
