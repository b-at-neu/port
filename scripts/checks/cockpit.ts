import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, pipelineSkillText } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// The worktree-reclamation blocks live in scripts/checks/worktrees.ts and
// the tick-query/pacing/ownership blocks in scripts/checks/cockpit-tick.ts
// (issue 181, splitting this module's own file-size ratchet entry) — this module
// keeps the cockpit rails, the liveness reset, the cycle cap and zero-diff
// gate, the TaskList liveness contract, and running-plugin staleness.
export default async function ({ expect, fail, ok }: Reporter) {
  // --- Cockpit rails stay checkable preconditions, not bare prohibitions ------
  // guard(#120, #138, #143): the cockpit looping gh and losing everything
  // but the first iteration mid-loop, clearing its own needs-human gate
  // unprompted under throughput pressure, or widening the terminal-state
  // rail back into a general licence to revisit approved — each rail was
  // "never do X" prose once, and the cockpit did X anyway.
  {
    const skillRel = 'plugins/port/skills/pipeline/SKILL.md';
    const text = readFileSync(join(root, skillRel), 'utf8');

    expect(/\bunblock\b/i.test(text), 'cockpit-rails', `${skillRel} never declares an 'unblock' command`);

    const batchForm = [...text.matchAll(/gh issue edit(?:\s+\d+){2,}/g)];
    expect(!(batchForm.length < 2), 'cockpit-rails', `${skillRel}: expected the batch form 'gh issue edit <n> <n> ...' to appear at least twice, found ${batchForm.length}`);

    expect(text.includes('only when an operator instruction names that item'), 'cockpit-rails', `${skillRel} is missing the gate rail's precondition phrase 'only when an operator instruction names that item'`);

    // Regression guard: the `<labels.approved>` never-touch rail is a
    // precondition too, not a bare prohibition — and the announcement that
    // claims a pull request is merge-ready has to show its work.
    expect(text.includes('only when a check on it has gone red, or a same-SHA refresh loop is stuck'), 'cockpit-rails', `${skillRel} is missing the approved-carve-out precondition phrase 'only when a check on it has gone red, or a same-SHA refresh loop is stuck'`);

    expect(/every check and its conclusion/.test(text), 'cockpit-rails', `${skillRel}'s approved-announcement copy never shows a check conclusion`);

    // guard(#288): the revise #N route's own precondition phrase, and the
    // comment-before-swap ordering inside its own bullet (so the request is
    // durable even when the swap's own compare-and-swap then fails).
    expect(text.includes("only when an operator's own message names that pull request and states the change it wants"), 'cockpit-rails', `${skillRel} is missing the revise #N precondition phrase "only when an operator's own message names that pull request and states the change it wants"`);

    const reviseBulletStart = text.indexOf('**"revise #N:');
    if (reviseBulletStart === -1) {
      fail('cockpit-rails', `${skillRel} has no "revise #N: <the change>" conversational command bullet`);
    } else {
      const reviseBulletEnd = text.indexOf('\n- **"refresh #N"', reviseBulletStart);
      const reviseBullet = reviseBulletEnd === -1 ? text.slice(reviseBulletStart) : text.slice(reviseBulletStart, reviseBulletEnd);
      const commentIdx = reviseBullet.indexOf('gh pr comment');
      const swapIdx = reviseBullet.indexOf('--remove-label "<labels.approved>"');
      expect(!(commentIdx === -1 || swapIdx === -1 || commentIdx > swapIdx), 'cockpit-rails', `${skillRel}'s "revise #N" bullet must post 'gh pr comment' before '--remove-label "<labels.approved>"', so the request survives a failed swap`);
    }
  }

  // --- Liveness reset — the cockpit resets only what it can prove it dispatched
  // guard(#150): a dead-agent reset firing on an item this session never
  // dispatched, or firing more than once per crash loop — every no-match
  // used to be treated identically (report, never act), leaving issues
  // 66/67 parked at `in progress` with no way to tell a dead dispatch from
  // someone else's live agent. This checks the split, its proof artifact,
  // and its one-reset cap are all still named.
  {
    const rel = 'plugins/port/skills/pipeline/*.md';
    const text = pipelineSkillText();

    expect(text.includes('.temp/dispatch-log.md'), 'liveness-reset', `${rel} never names the '.temp/dispatch-log.md' artifact`);

    expect(text.includes("reset only an item this session's own dispatch log records"), 'liveness-reset', `${rel} is missing the literal precondition phrase "reset only an item this session's own dispatch log records"`);

    expect(text.includes('at most one automatic reset per item per session'), 'liveness-reset', `${rel} is missing the literal phrase 'at most one automatic reset per item per session'`);

    // Issue 189: CONFLICTING no longer removes '<labels.approved>' — it adds
    // '<labels.refreshBranch>' instead, leaving the approval in place.
    expect(text.includes('adding `<labels.refreshBranch>` to an approved pull request when `mergeable` reads `CONFLICTING` is permitted'), 'liveness-reset', `${rel}'s '<labels.approved>' carve-out never documents the refresh-without-withdrawal fact`);
  }

  // --- Unconditional cycle cap and the zero-diff review gate -----------------
  // guard(#162): a review cycle cap that never fires on a clean-but-unmerged
  // bounce, and a review dispatched twice against a diff it already graded.
  // Pull request 157 ran 7 cycles because the cap only fired "and the latest
  // review still produced Critical or Medium findings" — a condition every
  // CI-only bounce arrives at clean, so it never fired. This checks the cap
  // dropped that qualifier, and that the zero-diff gate names the fields
  // and comment it reads.
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

      expect(!capSection.includes('and the latest review still produced Critical or Medium findings'), 'cycle-cap', `${skillRel}'s cycle cap still carries the 'and the latest review still produced Critical or Medium findings' qualifier — this is exactly what let #157 bounce through 7 clean cycles`);

      expect(capSection.includes('unconditional'), 'cycle-cap', `${skillRel}'s cycle cap section never states the cap is 'unconditional'`);
    }

    const combinedText = pipelineSkillText();
    const zeroDiffStart = combinedText.indexOf('Zero-diff review gate');
    if (zeroDiffStart === -1) {
      fail('zero-diff-review', `plugins/port/skills/pipeline/*.md never declares a 'Zero-diff review gate'`);
    } else {
      const zeroDiffEnd = combinedText.indexOf('\n**File contention gate', zeroDiffStart);
      const zeroDiffSection = zeroDiffEnd === -1 ? combinedText.slice(zeroDiffStart) : combinedText.slice(zeroDiffStart, zeroDiffEnd);
      for (const phrase of ['commit.oid', 'headRefOid', '## Gate cleared']) {
        expect(zeroDiffSection.includes(phrase), 'zero-diff-review', `plugins/port/skills/pipeline/*.md's zero-diff review gate never names '${phrase}'`);
      }
    }

    expect(pipelineText.includes('unconditional'), 'cycle-cap', `${pipelineRel} never states the cycle cap is 'unconditional'`);

    expect(pipelineText.includes('Zero-diff review'), 'zero-diff-review', `${pipelineRel} carries no 'Zero-diff review' rule`);
  }

  // --- Liveness is a TaskList call, never a label inference -------------------
  // guard(#158): TaskList was granted and referenced but never actually
  // called across 96 ticks and 62 dispatches, and when asked a direct
  // liveness question the cockpit answered from labels, then blamed the
  // operator's own observation on a stale UI element. This checks the
  // unconditional-call contract, the inverse-sign rail, the
  // liveness-question recipe's three prohibitions, and that both stop paths
  // name TaskList and TaskStop.
  {
    const rel = 'plugins/port/skills/pipeline/*.md';
    const text = pipelineSkillText();

    expect(/a tick that reports on liveness without a `?TaskList`? call this tick has failed/i.test(text), 'liveness-call', `${rel} is missing the literal unconditional-call phrase 'a tick that reports on liveness without a TaskList call this tick has failed'`);

    expect(text.includes('not evidence of liveness or of non-liveness'), 'liveness-call', `${rel} is missing the literal inverse-sign phrase 'not evidence of liveness or of non-liveness'`);

    expect(text.includes('stale UI element'), 'liveness-call', `${rel} never names the 'stale UI element' failure the liveness recipe exists to prevent`);

    expect(!(/\bI don't have a way to\b.*\bagent\b/i.test(text) || /the tool is unavailable\.[^N]/i.test(text)), 'liveness-call', `${rel} appears to claim the TaskList tool is unavailable somewhere outside the never-do rail`);

    const stopN = /- \*\*"stop #N"[\s\S]*?(?=\n- \*\*"stop everything")/.exec(text)?.[0] ?? '';
    const stopAll = /- \*\*"stop everything"[\s\S]*?(?=\n## Pacing)/.exec(text)?.[0] ?? '';
    for (const [label, section] of [['stop #N', stopN], ['stop everything', stopAll]]) {
      if (!section) {
        fail('liveness-call', `${rel} has no '${label}' entry under Stop controls to check`);
        continue;
      }
      for (const tool of ['TaskList', 'TaskStop']) {
        expect(section.includes(tool), 'liveness-call', `${rel}'s '${label}' entry never names '${tool}'`);
      }
    }
  }

  // --- Running-plugin staleness is resolved, not printed from a path ---------
  // guard(#158, #127): the startup line used to report only a path,
  // identical for a current and a days-stale copy. This checks the
  // resolution mechanism is named (the registry, the marketplace record, the
  // scope precedence), that the new tick-state field is written in both
  // places that must stay in sync, that CONTRIBUTING.md carries the three-way
  // ground-truth test and the corrected cache-path claim, and that the new
  // staleness prose in PREFLIGHT.md never hard-codes this repository's own
  // name — the generality requirement the feature is supposed to satisfy for
  // every consumer, not just this one.
  {
    const unionRel = 'plugins/port/skills/pipeline/*.md';
    const preflightRel = 'plugins/port/skills/pipeline/PREFLIGHT.md';
    const contributingRel = 'CONTRIBUTING.md';
    const unionText = pipelineSkillText();
    const preflightText = readFileSync(join(root, preflightRel), 'utf8');
    const contributingText = readFileSync(join(root, contributingRel), 'utf8');

    for (const phrase of ['installed_plugins.json', 'gitCommitSha', 'known_marketplaces.json', 'commits behind']) {
      expect(unionText.includes(phrase), 'plugin-staleness', `${unionRel} never names '${phrase}'`);
    }

    expect(unionText.includes('local > project > user'), 'plugin-staleness', `${unionRel} never states the 'local > project > user' scope precedence`);

    const tickStateMentions = [...unionText.matchAll(/Plugin staleness/g)].length;
    expect(!(tickStateMentions < 2), 'plugin-staleness', `${unionRel} names 'Plugin staleness' only ${tickStateMentions} time(s) — it must appear in both the Startup preflight tick-state template and the Tick procedure's field list`);

    expect(!(!contributingText.includes('git rev-list --count') || !contributingText.includes('diff -rq')), `plugin-staleness`, `${contributingRel} is missing one half of the three-way test ('git rev-list --count' and 'diff -rq')`);

    expect(/a cache path is not evidence of a stale copy/i.test(contributingText), 'plugin-staleness', `${contributingRel} is missing the literal correction 'a cache path is not evidence of a stale copy'`);

    // Generality: the staleness prose (Startup preflight step 4 through the
    // start of step 5, now in PREFLIGHT.md) must derive the marketplace,
    // owner, and target ref from config/the plugin registry — never
    // hard-code this repository's own name. UX-state blockquote lines are
    // exempt, matching how the existing UX-state copy already shows
    // concrete example names.
    const start = preflightText.indexOf('**Step 4 — integration drift');
    const end = preflightText.indexOf('**Step 5 — label vocabulary');
    if (start === -1 || end === -1) {
      fail('plugin-staleness', `${preflightRel} is missing the Startup preflight staleness step (Step 4 → Step 5)`);
    } else {
      const proseLines = preflightText
        .slice(start, end)
        .split('\n')
        .filter((line) => !line.trim().startsWith('>'));
      const prose = proseLines.join('\n');
      for (const literal of ['b-at-neu/port', '`dev`', '0.1.0']) {
        expect(!prose.includes(literal), 'plugin-staleness', `${preflightRel}'s staleness step names the literal '${literal}' outside a UX-state example — it must derive from config or the plugin registry`);
      }
    }
  }

  // --- Operator-facing copy names the ticket, never a bare PR number ---------
  // guard(#281): the cockpit's own report prose mixing the issue (ticket)
  // number and the pull request's own GitHub-assigned number for one piece of
  // pipeline work — a bare `PR #<n>` is always the pull request's own
  // number, silently divergent from the ticket number the rest of the report
  // names, with nothing marking it as such.
  {
    const skillRel = 'plugins/port/skills/pipeline/SKILL.md';
    const pipelineRel = 'plugins/port/docs/PIPELINE.md';
    const unionRel = 'plugins/port/skills/pipeline/*.md';
    const skillText = readFileSync(join(root, skillRel), 'utf8');
    const pipelineText = readFileSync(join(root, pipelineRel), 'utf8');
    const unionText = pipelineSkillText();

    const bareNumberMatch = /\bPR #/.exec(unionText);
    if (bareNumberMatch) {
      const line = unionText.slice(0, bareNumberMatch.index).split('\n').length;
      fail('cockpit-numbering', `${unionRel} still carries a bare 'PR #' at or near line ${line} — operator-facing copy names the ticket number, never the pull request's own`);
    } else {
      ok();
    }

    expect(skillText.includes("names the ticket number, never the pull request's own"), 'cockpit-numbering', `${skillRel} is missing the literal rule phrase 'names the ticket number, never the pull request's own'`);

    expect(!pipelineText.includes('the command takes the pull request number'), 'cockpit-numbering', `${pipelineRel} still carries the stale caveat 'the command takes the pull request number' — /port:implement now resolves a ticket to its pull request (#281)`);
    expect(!unionText.includes('the command takes the pull request number'), 'cockpit-numbering', `${unionRel} still carries the stale caveat 'the command takes the pull request number' — /port:implement now resolves a ticket to its pull request (#281)`);
  }
}
