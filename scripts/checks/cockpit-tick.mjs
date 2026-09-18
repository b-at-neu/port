import { pipelineSkillText } from '../lib/files.mjs';

// The tick query, pacing ladder, busy-wait, and ownership/blind-tick blocks
// split out of scripts/checks/cockpit.mjs (issue 181, splitting that module's own
// file-size ratchet entry).
export default async function ({ fail, ok }) {
  const rel = 'plugins/port/skills/pipeline/*.md';

  // --- Collapsed tick query — one round trip, never a per-label poll ---------
  // guard(#148): a tick regressing from one collapsed round trip back to
  // ~15 per-label `gh issue list`/`gh pr list --label` REST calls. This
  // checks the Tick procedure names the collapsed single-call contract and
  // that no per-label poll crept back in under that heading — scoped there,
  // so the Configuration section's illustrative `--label <unknown>` mention
  // is correctly exempt.
  {
    const text = pipelineSkillText();

    for (const phrase of ['gh api graphql', '--include', '.temp/tick-state.md']) {
      if (!text.includes(phrase)) {
        fail('tick-query', `${rel} never names '${phrase}' — the collapsed tick contract is missing a piece`);
      } else {
        ok();
      }
    }

    // Scans the whole union rather than one heading-scoped section — issue
    // 203 split the Tick procedure across two files, and a per-label poll
    // creeping back into either is equally a regression. The Configuration
    // section's own illustrative `--label <unknown>` (explaining why a wrong
    // string is silent, not a real polling call) is exempt.
    const pollRe = /gh (?:issue|pr) list[^\n]*--label(?!\s*<unknown>)/g;
    const hits = [...text.matchAll(pollRe)];
    if (hits.length > 0) {
      fail(
        'tick-query',
        `${rel}'s tick procedure still issues a per-label poll (${JSON.stringify(hits[0][0])}) — the collapse must fold it into the one query`,
      );
    } else {
      ok();
    }
  }

  // --- Pacing ladder — reset-on-change and never-stop are checkable, not prose
  // guard(#148): the two-speed pacing rule — which measured as one speed in
  // a real 25-hour run (26 of 27 wakeups at the floor) because it conflated
  // "an agent is running" with "something will move without a human" —
  // regressing back in. This checks the ladder's constants and its two
  // preconditions are still literal, checkable phrases.
  {
    const text = pipelineSkillText();

    for (const n of ['270', '540', '1080', '1800']) {
      if (!text.includes(n)) {
        fail('pacing-ladder', `${rel} is missing the ladder constant '${n}'`);
      } else {
        ok();
      }
    }

    if (!text.includes('Reset to the floor immediately on any observed change')) {
      fail(
        'pacing-ladder',
        `${rel} is missing the literal reset-on-change phrase 'Reset to the floor immediately on any observed change'`,
      );
    } else {
      ok();
    }

    if (!text.includes('Never stop — a stopped cockpit is the only dispatcher')) {
      fail(
        'pacing-ladder',
        `${rel} is missing the literal never-stop phrase 'Never stop — a stopped cockpit is the only dispatcher'`,
      );
    } else {
      ok();
    }
  }

  // --- No busy-waiting in the cockpit skill -----------------------------------
  // guard(#148): the cockpit blocking a turn on sleep/--watch instead of
  // letting the next scheduled tick or completion do the waiting — a real
  // run issued 6 `sleep`-based waits inside tool calls.
  {
    const text = pipelineSkillText();
    if (/\bsleep\s+\d/.test(text)) {
      fail('no-busy-wait', `${rel} contains a 'sleep <n>'-shaped busy-wait — the next tick is how this cockpit waits`);
    } else {
      ok();
    }
  }

  // --- Ownership enforced client-side, and the blind-tick contract -----------
  // guard(#148): dropping the per-alias assignee filter (what makes the
  // unowned sweep derivable from one call) silently dropping the ownership
  // rail with it, and a failed collapsed query being read as an empty,
  // all-clear tick.
  {
    const text = pipelineSkillText();

    if (!text.includes('never acted on, only reported')) {
      fail(
        'tick-query',
        `${rel} is missing the literal client-side ownership precondition phrase 'never acted on, only reported'`,
      );
    } else {
      ok();
    }

    if (!text.includes('dispatch nothing, run no hygiene, reset nothing')) {
      fail(
        'tick-query',
        `${rel} is missing the literal blind-tick precondition phrase 'dispatch nothing, run no hygiene, reset nothing'`,
      );
    } else {
      ok();
    }
  }
}
