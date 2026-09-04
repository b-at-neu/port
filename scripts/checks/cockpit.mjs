import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson } from '../lib/files.mjs';

export default async function ({ fail, ok }) {
  // --- Worktree reclamation template is self-contained and cross-platform ----
  // Mirrors the artifacts-template rule: an adopting repository copies
  // worktrees.mjs alone, and the script must never shell out via a POSIX-only
  // binary name or a shell string, or it breaks silently on Windows (#144).
  {
    const rel = 'plugins/port/templates/worktrees.mjs';
    const text = readFileSync(join(root, rel), 'utf8');

    const relativeImport = /\bfrom\s+['"]\.\.?\//.exec(text);
    if (relativeImport) {
      fail('worktrees-template', `${rel} has a relative import (${JSON.stringify(relativeImport[0])}) — it must be self-contained`);
    } else {
      ok();
    }

    if (/\bexecSync\b/.test(text)) {
      fail('worktrees-template', `${rel} uses execSync — every child process must use spawnSync with an explicit argv array`);
    } else {
      ok();
    }

    if (/shell:\s*true/.test(text)) {
      fail('worktrees-template', `${rel} passes shell: true to a child process — every call must be an explicit argv array, never a shell string`);
    } else {
      ok();
    }

    // Strip comment-only lines first — the file's own docstring names both
    // forbidden calls as a disclaimer ("Never in this script: `git fetch`,
    // `git worktree add`, …"), which must not itself trip this check.
    const codeOnly = text
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    if (/git\(\[['"]fetch['"]|git\(\[[^\]]*['"]worktree['"],\s*['"]add['"]/.test(codeOnly)) {
      fail('worktrees-template', `${rel} must never run 'git fetch' or 'git worktree add' — those are outside its contract`);
    } else {
      ok();
    }
  }

  // --- Worktree reclamation classifier ----------------------------------------
  // Unit-tests the pure functions in isolation from every git/gh call — each
  // case is a rung of the correlation ladder, a precedence rule from the
  // classification table, or an acceptance criterion the ticket named.
  {
    const { parsePorcelain, correlate, classifyCandidate } =
      await import(pathToFileURL(join(root, 'plugins/port/templates/worktrees.mjs')).href);

    // parsePorcelain: main worktree first, a linked one, a locked one with a
    // reason, and a detached one.
    {
      const porcelain = [
        'worktree /repo',
        'HEAD aaaa111',
        'branch refs/heads/dev',
        '',
        'worktree /repo/.claude/worktrees/impl-144',
        'HEAD bbbb222',
        'branch refs/heads/144-worktree-reclaim-install-guard',
        '',
        'worktree /repo/.claude/worktrees/agent-abc',
        'HEAD cccc333',
        'detached',
        'locked reason: agent still running',
        '',
      ].join('\n');
      const records = parsePorcelain(porcelain);
      if (records.length !== 3) {
        fail('worktrees-classifier', `parsePorcelain: expected 3 records, got ${records.length}`);
      } else if (records[0].path !== '/repo' || records[1].branch !== '144-worktree-reclaim-install-guard') {
        fail('worktrees-classifier', `parsePorcelain: unexpected record shape ${JSON.stringify(records)}`);
      } else if (!records[2].locked || records[2].lockReason !== 'reason: agent still running' || !records[2].detached) {
        fail('worktrees-classifier', `parsePorcelain: locked/detached record parsed wrong: ${JSON.stringify(records[2])}`);
      } else {
        ok();
      }
    }

    // correlate: each rung in turn, first hit wins, and #0 is never a
    // correlation.
    {
      const cases = [
        [{ upstreamMergeRef: 'refs/heads/503-fix-thing' }, { number: 503, rung: 'upstream-branch' }],
        [{ branch: '149-foo' }, { number: 149, rung: 'branch-name' }],
        [{ dirBasename: 'impl-77' }, { number: 77, rung: 'directory-basename' }],
        [{ headSubject: '#67 fix the thing' }, { number: 67, rung: 'head-subject' }],
        [{ headSubject: '#0 something' }, null],
        [{ headSubject: 'Merge pull request #157 from x' }, null],
        [{}, null],
        // First hit wins: upstream beats a branch name that would also match.
        [{ upstreamMergeRef: 'refs/heads/12-a', branch: '99-b' }, { number: 12, rung: 'upstream-branch' }],
      ];
      for (const [input, expected] of cases) {
        const got = correlate(input);
        const gotStr = JSON.stringify(got);
        const expStr = JSON.stringify(expected);
        if (gotStr !== expStr) {
          fail('worktrees-classifier', `correlate(${JSON.stringify(input)}): expected ${expStr}, got ${gotStr}`);
        } else {
          ok();
        }
      }
    }

    // classifyCandidate: precedence outside → protect → locked → dirty →
    // active → done/no-work → unresolved.
    {
      const cases = [
        ['outside beats everything', { isOutside: true, isProtected: true, locked: true, dirty: true, itemState: 'OPEN' }, 'outside', false],
        ['protect forces active over a done state', { isProtected: true, itemState: 'MERGED' }, 'active', false],
        ['locked beats a done state — reclaimable once unlocked', { locked: true, itemState: 'CLOSED' }, 'locked', false],
        ['dirty downgrades an otherwise-removable no-work candidate', { dirty: true, itemState: null, isAncestor: true }, 'dirty', false],
        ['dirty is irrelevant to an active candidate', { dirty: true, itemState: 'OPEN' }, 'active', false],
        ['OPEN is active, never removable', { itemState: 'OPEN' }, 'active', false],
        ['CLOSED is done, removable', { itemState: 'CLOSED' }, 'done', true],
        ['MERGED is done, removable', { itemState: 'MERGED' }, 'done', true],
        ['no correlation, HEAD is an ancestor of integration → no-work, removable', { itemState: null, isAncestor: true }, 'no-work', true],
        ['no correlation, HEAD is not an ancestor → unresolved, never removable', { itemState: null, isAncestor: false }, 'unresolved', false],
        ['NOT_FOUND (itemState null with no ancestor fact) → unresolved, never done', { itemState: null, isAncestor: null }, 'unresolved', false],
      ];
      for (const [label, input, expectedState, expectedRemovable] of cases) {
        const full = { isOutside: false, isProtected: false, locked: false, dirty: false, itemState: null, isAncestor: null, ...input };
        const got = classifyCandidate(full);
        if (got.state !== expectedState || got.removable !== expectedRemovable) {
          fail(
            'worktrees-classifier',
            `classifyCandidate — ${label}: expected {state: '${expectedState}', removable: ${expectedRemovable}}, got ${JSON.stringify(got)}`,
          );
        } else {
          ok();
        }
      }
    }
  }

  // --- Cockpit hygiene invokes the worktree script, never bare git worktree --
  // Regression guard against #144's own fix collapsing back into the prose
  // #62 already tried once: the cockpit's hygiene section must call
  // `commands.worktrees` and must not itself run `git worktree remove`.
  {
    const rel = 'plugins/port/skills/pipeline/SKILL.md';
    const text = readFileSync(join(root, rel), 'utf8');

    if (!text.includes('commands.worktrees')) {
      fail('worktree-hygiene', `${rel} never names 'commands.worktrees' — hygiene must be delegated to the script, not reimplemented in prose`);
    } else {
      ok();
    }

    const hygieneStart = text.indexOf('Worktree hygiene');
    if (hygieneStart === -1) {
      fail('worktree-hygiene', `${rel} has no 'Worktree hygiene' section`);
    } else {
      const hygieneEnd = text.indexOf('\n**Denial report', hygieneStart);
      const hygieneSection = hygieneEnd === -1 ? text.slice(hygieneStart) : text.slice(hygieneStart, hygieneEnd);
      if (/git worktree remove --force/.test(hygieneSection)) {
        fail('worktree-hygiene', `${rel}'s hygiene section still invokes 'git worktree remove --force' directly — this must be the script's job now`);
      } else {
        ok();
      }
    }
  }

  // --- Cockpit's config table carries commands.worktrees ----------------------
  // The schema, the template, and self-hosting all name the same key — a
  // mismatch here means the cockpit reads a placeholder nothing ever sets.
  {
    const schemaProps = readJson('schema/port.config.schema.json').properties.commands.properties;
    if (!schemaProps.worktrees) {
      fail('worktree-hygiene', "schema/port.config.schema.json's commands object has no 'worktrees' property");
    } else {
      ok();
    }

    const template = readJson('plugins/port/templates/port.config.json');
    if (!('worktrees' in (template.commands ?? {}))) {
      fail('worktree-hygiene', 'plugins/port/templates/port.config.json has no commands.worktrees key');
    } else {
      ok();
    }

    const selfHost = readJson('.claude/port.config.json');
    if (typeof selfHost.commands?.worktrees !== 'string') {
      fail('worktree-hygiene', ".claude/port.config.json's commands.worktrees must be set for this repository's own self-hosting");
    } else {
      ok();
    }
  }

  // --- Cockpit rails stay checkable preconditions, not bare prohibitions ------
  // Regression guard for #120 / #138: both rails were plain "never do X"
  // prose, and the cockpit did X anyway under a competing incentive. The fix
  // re-shaped them into a batch recipe (shown inline at the multi-item
  // commands) and a precondition (`unblock #N`) — this fails if a future edit
  // quietly reverts either back to prose with nothing to check against.
  {
    const skillRel = 'plugins/port/skills/pipeline/SKILL.md';
    const text = readFileSync(join(root, skillRel), 'utf8');

    if (!/\bunblock\b/i.test(text)) {
      fail('cockpit-rails', `${skillRel} never declares an 'unblock' command`);
    } else {
      ok();
    }

    const batchForm = [...text.matchAll(/gh issue edit(?:\s+\d+){2,}/g)];
    if (batchForm.length < 2) {
      fail('cockpit-rails', `${skillRel}: expected the batch form 'gh issue edit <n> <n> ...' to appear at least twice, found ${batchForm.length}`);
    } else {
      ok();
    }

    if (!text.includes('only when an operator instruction names that item')) {
      fail('cockpit-rails', `${skillRel} is missing the gate rail's precondition phrase 'only when an operator instruction names that item'`);
    } else {
      ok();
    }

    // Regression guard: the `<labels.approved>` never-touch rail is a
    // precondition too, not a bare prohibition — and the announcement that
    // claims a pull request is merge-ready has to show its work.
    if (!text.includes('only when a check on it has gone red')) {
      fail('cockpit-rails', `${skillRel} is missing the approved-carve-out precondition phrase 'only when a check on it has gone red'`);
    } else {
      ok();
    }

    if (!/every check and its conclusion/.test(text)) {
      fail('cockpit-rails', `${skillRel}'s approved-announcement copy never shows a check conclusion`);
    } else {
      ok();
    }
  }

  // --- Liveness reset — the cockpit resets only what it can prove it dispatched
  // Regression guard for #150: every no-match used to be treated identically
  // (report, never act), which left #66/#67 parked at `in progress` across a
  // session boundary with no way to tell "this session's own dead dispatch"
  // apart from "someone else's live agent" — recovery was a human noticing.
  // This checks that the split, its proof artifact, and its one-reset cap are
  // all still named, not quietly reverted to the old single-branch prose.
  {
    const rel = 'plugins/port/skills/pipeline/SKILL.md';
    const text = readFileSync(join(root, rel), 'utf8');

    if (!text.includes('.temp/dispatch-log.md')) {
      fail('liveness-reset', `${rel} never names the '.temp/dispatch-log.md' artifact`);
    } else {
      ok();
    }

    if (!text.includes("reset only an item this session's own dispatch log records")) {
      fail(
        'liveness-reset',
        `${rel} is missing the literal precondition phrase "reset only an item this session's own dispatch log records"`,
      );
    } else {
      ok();
    }

    if (!text.includes('at most one automatic reset per item per session')) {
      fail(
        'liveness-reset',
        `${rel} is missing the literal phrase 'at most one automatic reset per item per session'`,
      );
    } else {
      ok();
    }

    if (!text.includes('GitHub reports it conflicting with its base')) {
      fail(
        'liveness-reset',
        `${rel}'s '<labels.approved>' carve-out never names the conflicting-with-base half`,
      );
    } else {
      ok();
    }
  }

  // --- Collapsed tick query — one round trip, never a per-label poll ---------
  // Regression guard for #148: a tick used to cost ~15 `gh issue list`/`gh pr
  // list --label` round trips. This checks that the Tick procedure actually
  // names the collapsed single-call contract, and that no per-label polling
  // call has crept back in under that heading — scoped to the Tick procedure
  // section itself, so the Configuration section's illustrative mention of
  // `gh issue list --label <unknown>` (explaining why a wrong string is silent,
  // not the tick's own polling call) is correctly exempt.
  {
    const rel = 'plugins/port/skills/pipeline/SKILL.md';
    const text = readFileSync(join(root, rel), 'utf8');

    for (const phrase of ['gh api graphql', '--include', '.temp/tick-state.md']) {
      if (!text.includes(phrase)) {
        fail('tick-query', `${rel} never names '${phrase}' — the collapsed tick contract is missing a piece`);
      } else {
        ok();
      }
    }

    const tickStart = text.indexOf('## Tick procedure');
    if (tickStart === -1) {
      fail('tick-query', `${rel} has no '## Tick procedure' heading`);
    } else {
      const tickEnd = text.indexOf('\n## ', tickStart + 1);
      const tickSection = tickEnd === -1 ? text.slice(tickStart) : text.slice(tickStart, tickEnd);
      const pollRe = /gh (?:issue|pr) list[^\n]*--label/g;
      const hits = [...tickSection.matchAll(pollRe)];
      if (hits.length > 0) {
        fail(
          'tick-query',
          `${rel}'s Tick procedure still issues a per-label poll (${JSON.stringify(hits[0][0])}) — the collapse must fold it into the one query`,
        );
      } else {
        ok();
      }
    }
  }

  // --- Pacing ladder — reset-on-change and never-stop are checkable, not prose
  // Regression guard for #148: the old pacing rule measured as one speed in
  // practice (26 of 27 wakeups at the floor over a real 25-hour run) because it
  // conflated "an agent is running" with "something will move without a
  // human". This checks the ladder's constants and its two load-bearing
  // preconditions are still literal, checkable phrases.
  {
    const rel = 'plugins/port/skills/pipeline/SKILL.md';
    const text = readFileSync(join(root, rel), 'utf8');

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
  // Regression guard for #148: a real run issued 6 `sleep`-based waits inside
  // tool calls, busy-waiting on CI instead of letting the next scheduled tick
  // (or an event-driven completion) do the waiting.
  {
    const rel = 'plugins/port/skills/pipeline/SKILL.md';
    const text = readFileSync(join(root, rel), 'utf8');
    if (/\bsleep\s+\d/.test(text)) {
      fail('no-busy-wait', `${rel} contains a 'sleep <n>'-shaped busy-wait — the next tick is how this cockpit waits`);
    } else {
      ok();
    }
  }

  // --- Ownership enforced client-side, and the blind-tick contract -----------
  // Regression guard for #148: dropping the per-alias assignee filter (what
  // makes the unowned sweep derivable from one call) must not silently drop
  // the ownership rail itself, and a failed collapsed query must never be
  // mistaken for an empty, all-clear tick.
  {
    const rel = 'plugins/port/skills/pipeline/SKILL.md';
    const text = readFileSync(join(root, rel), 'utf8');

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

  // --- Unconditional cycle cap and the zero-diff review gate (#162) ----------
  // Regression guard for #162: PR #157 ran 7 review cycles because the cap
  // only fired "at reviewCycleCap and the latest review still produced
  // Critical or Medium findings" — a condition every CI-only bounce (a
  // liveness reset, an approval withdrawal, a manual re-label) arrives at
  // with a clean latest review, so it never fired. This checks the cap
  // dropped that qualifier, and that the zero-diff gate it gained alongside
  // names the fields and comment it reads.
  {
    const skillRel = 'plugins/port/skills/pipeline/SKILL.md';
    const pipelineRel = 'plugins/port/docs/PIPELINE.md';
    const skillText = readFileSync(join(root, skillRel), 'utf8');
    const pipelineText = readFileSync(join(root, pipelineRel), 'utf8');

    const capStart = skillText.indexOf('### Cycle cap');
    if (capStart === -1) {
      fail('cycle-cap', `${skillRel} has no '### Cycle cap' section`);
    } else {
      const capEnd = skillText.indexOf('\n## ', capStart);
      const capSection = capEnd === -1 ? skillText.slice(capStart) : skillText.slice(capStart, capEnd);

      if (capSection.includes('and the latest review still produced Critical or Medium findings')) {
        fail(
          'cycle-cap',
          `${skillRel}'s cycle cap still carries the 'and the latest review still produced Critical or Medium findings' qualifier — this is exactly what let #157 bounce through 7 clean cycles`,
        );
      } else {
        ok();
      }

      if (!capSection.includes('unconditional')) {
        fail('cycle-cap', `${skillRel}'s cycle cap section never states the cap is 'unconditional'`);
      } else {
        ok();
      }
    }

    const zeroDiffStart = skillText.indexOf('Zero-diff review gate');
    if (zeroDiffStart === -1) {
      fail('zero-diff-review', `${skillRel} never declares a 'Zero-diff review gate'`);
    } else {
      const zeroDiffEnd = skillText.indexOf('\n**File contention gate', zeroDiffStart);
      const zeroDiffSection = zeroDiffEnd === -1 ? skillText.slice(zeroDiffStart) : skillText.slice(zeroDiffStart, zeroDiffEnd);
      for (const phrase of ['commit.oid', 'headRefOid', '## Gate cleared']) {
        if (!zeroDiffSection.includes(phrase)) {
          fail('zero-diff-review', `${skillRel}'s zero-diff review gate never names '${phrase}'`);
        } else {
          ok();
        }
      }
    }

    if (!pipelineText.includes('unconditional')) {
      fail('cycle-cap', `${pipelineRel} never states the cycle cap is 'unconditional'`);
    } else {
      ok();
    }

    if (!pipelineText.includes('Zero-diff review')) {
      fail('zero-diff-review', `${pipelineRel} carries no 'Zero-diff review' rule`);
    } else {
      ok();
    }
  }

  // --- Liveness is a TaskList call, never a label inference (#158) -----------
  // Regression guard for #158: TaskList was granted and referenced but never
  // actually called across 96 ticks and 62 dispatches, and when asked a direct
  // liveness question the cockpit answered from labels, then blamed the
  // operator's own observation on a stale UI element. This checks the
  // unconditional-call contract, the inverse-sign rail, the liveness-question
  // recipe's three prohibitions, and that both stop paths name TaskList and
  // TaskStop.
  {
    const rel = 'plugins/port/skills/pipeline/SKILL.md';
    const text = readFileSync(join(root, rel), 'utf8');

    if (!/a tick that reports on liveness without a `?TaskList`? call this tick has failed/i.test(text)) {
      fail(
        'liveness-call',
        `${rel} is missing the literal unconditional-call phrase 'a tick that reports on liveness without a TaskList call this tick has failed'`,
      );
    } else {
      ok();
    }

    if (!text.includes('not evidence of liveness or of non-liveness')) {
      fail(
        'liveness-call',
        `${rel} is missing the literal inverse-sign phrase 'not evidence of liveness or of non-liveness'`,
      );
    } else {
      ok();
    }

    if (!text.includes('stale UI element')) {
      fail('liveness-call', `${rel} never names the 'stale UI element' failure the liveness recipe exists to prevent`);
    } else {
      ok();
    }

    if (/\bI don't have a way to\b.*\bagent\b/i.test(text) || /the tool is unavailable\.[^N]/i.test(text)) {
      fail('liveness-call', `${rel} appears to claim the TaskList tool is unavailable somewhere outside the never-do rail`);
    } else {
      ok();
    }

    const stopN = /- \*\*"stop #N"[\s\S]*?(?=\n- \*\*"stop everything")/.exec(text)?.[0] ?? '';
    const stopAll = /- \*\*"stop everything"[\s\S]*?(?=\n## Pacing)/.exec(text)?.[0] ?? '';
    for (const [label, section] of [['stop #N', stopN], ['stop everything', stopAll]]) {
      if (!section) {
        fail('liveness-call', `${rel} has no '${label}' entry under Stop controls to check`);
        continue;
      }
      for (const tool of ['TaskList', 'TaskStop']) {
        if (!section.includes(tool)) {
          fail('liveness-call', `${rel}'s '${label}' entry never names '${tool}'`);
        } else {
          ok();
        }
      }
    }
  }

  // --- Running-plugin staleness is resolved, not printed from a path (#158) --
  // Regression guard for #158/#127: the startup line used to report only a
  // path, identical for a current and a days-stale copy. This checks the
  // resolution mechanism is named (the registry, the marketplace record, the
  // scope precedence), that the new tick-state field is written in both
  // places that must stay in sync, that CONTRIBUTING.md carries the three-way
  // ground-truth test and the corrected cache-path claim, and that the new
  // staleness prose in SKILL.md never hard-codes this repository's own name —
  // the generality requirement the feature is supposed to satisfy for every
  // consumer, not just this one.
  {
    const skillRel = 'plugins/port/skills/pipeline/SKILL.md';
    const contributingRel = 'CONTRIBUTING.md';
    const skillText = readFileSync(join(root, skillRel), 'utf8');
    const contributingText = readFileSync(join(root, contributingRel), 'utf8');

    for (const phrase of ['installed_plugins.json', 'gitCommitSha', 'known_marketplaces.json', 'commits behind']) {
      if (!skillText.includes(phrase)) {
        fail('plugin-staleness', `${skillRel} never names '${phrase}'`);
      } else {
        ok();
      }
    }

    if (!skillText.includes('local > project > user')) {
      fail('plugin-staleness', `${skillRel} never states the 'local > project > user' scope precedence`);
    } else {
      ok();
    }

    const tickStateMentions = [...skillText.matchAll(/Plugin staleness/g)].length;
    if (tickStateMentions < 2) {
      fail(
        'plugin-staleness',
        `${skillRel} names 'Plugin staleness' only ${tickStateMentions} time(s) — it must appear in both the Startup preflight tick-state template and the Tick procedure's field list`,
      );
    } else {
      ok();
    }

    if (!contributingText.includes('git rev-list --count') || !contributingText.includes('diff -rq')) {
      fail(`plugin-staleness`, `${contributingRel} is missing one half of the three-way test ('git rev-list --count' and 'diff -rq')`);
    } else {
      ok();
    }

    if (!/a cache path is not evidence of a stale copy/i.test(contributingText)) {
      fail(
        'plugin-staleness',
        `${contributingRel} is missing the literal correction 'a cache path is not evidence of a stale copy'`,
      );
    } else {
      ok();
    }

    // Generality: the staleness prose (Startup preflight step 4 through the
    // start of step 5) must derive the marketplace, owner, and target ref from
    // config/the plugin registry — never hard-code this repository's own name.
    // UX-state blockquote lines are exempt, matching how the existing UX-state
    // copy already shows concrete example names.
    const start = skillText.indexOf('**Step 4 — integration drift');
    const end = skillText.indexOf('**Step 5 — label vocabulary');
    if (start === -1 || end === -1) {
      fail('plugin-staleness', `${skillRel} is missing the Startup preflight staleness step (Step 4 → Step 5)`);
    } else {
      const proseLines = skillText
        .slice(start, end)
        .split('\n')
        .filter((line) => !line.trim().startsWith('>'));
      const prose = proseLines.join('\n');
      for (const literal of ['b-at-neu/port', '`dev`', '0.1.0']) {
        if (prose.includes(literal)) {
          fail(
            'plugin-staleness',
            `${skillRel}'s staleness step names the literal '${literal}' outside a UX-state example — it must derive from config or the plugin registry`,
          );
        } else {
          ok();
        }
      }
    }
  }
}
