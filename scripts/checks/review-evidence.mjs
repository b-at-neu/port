import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '../lib/files.mjs';

export default async function ({ fail, ok }) {
  // --- Review evidence gate — verdicts wait for concluded checks --------------
  // Regression guard: review-agent could form a verdict before the head
  // commit's own artifact check had concluded — a check with no conclusion is
  // pending, not passing, but was read as passing. This checks that the agent
  // definition actually says to
  // wait, names the timeout verdict, and conditions the one carve-out on the
  // module that installs it, rather than a literal check name that would break
  // the moment a repository renamed its workflow job.
  {
    const rel = 'plugins/port/agents/review-agent.md';
    const text = readFileSync(join(root, rel), 'utf8');

    if (!text.includes('statusCheckRollup')) {
      fail('review-evidence', `${rel} never reads 'statusCheckRollup' — the evidence gate has nothing to reduce`);
    } else {
      ok();
    }

    if (!text.includes('--watch')) {
      fail('review-evidence', `${rel} never uses 'gh pr checks --watch' — nothing bounds the wait for pending checks`);
    } else {
      ok();
    }

    if (!text.includes('no verdict is formed while any check on the head commit is pending')) {
      fail('review-evidence', `${rel} is missing the literal phrase 'no verdict is formed while any check on the head commit is pending'`);
    } else {
      ok();
    }

    if (!/modules\.approvalGate/.test(text)) {
      fail('review-evidence', `${rel} never conditions the carve-out on 'modules.approvalGate'`);
    } else {
      ok();
    }

    if (!text.includes('blocked — checks pending')) {
      fail('review-evidence', `${rel} never names the 'blocked — checks pending' verdict`);
    } else {
      ok();
    }
  }

  // --- Generality guard — no literal CI check name in a stage prompt ----------
  // Regression guard: hard-coding a check name (rather than deriving the one
  // excused check from approval-check.yml's own jobs: key) breaks the moment a
  // repository renames its workflow job or runs a different CI setup.
  // `skills/init/SKILL.md` is deliberately exempt — it tells the operator which
  // check to mark required, which is the one legitimate literal.
  {
    const bannedNames = ['run-approval-check', 'run-static-checks', 'audit-artifacts', 'run-behavioural-evals'];
    const scanDirs = [join(root, 'plugins/port/agents'), join(root, 'plugins/port/skills/pipeline')];
    for (const dir of scanDirs) {
      for (const f of walk(dir).filter((p) => p.endsWith('.md'))) {
        const rel = relOf(f);
        const text = readFileSync(f, 'utf8');
        for (const name of bannedNames) {
          if (text.includes(name)) {
            fail('review-evidence', `${rel} names the literal check '${name}' — check identity must come from the repository's own workflow, never a hard-coded string`);
          }
        }
      }
    }
    ok();
  }

  // --- Rebase protocol resolves-and-escalates, not fail-closed-and-narrate ----
  // Regression guard: a protocol that aborts the whole rebase on any single
  // ambiguous hunk discards the correct resolution of every other one, and
  // escalating by dumping conflict markers at a human who was never going to
  // open an editor is unhelpful. This checks that the widened auto-resolvable
  // rows and the decision-request escalation format are both still present.
  {
    const rel = 'plugins/port/docs/PIPELINE.md';
    const text = readFileSync(join(root, rel), 'utf8');

    for (const phrase of ['take the union', 'deterministic order', 'apply the addition inside the new structure']) {
      if (!text.includes(phrase)) {
        fail('rebase-protocol', `${rel} is missing the auto-resolvable phrase '${phrase}'`);
      } else {
        ok();
      }
    }

    for (const name of ['sessionRequiredPaths', 'migration', 'environment', 'build configuration']) {
      if (!text.includes(name)) {
        fail('rebase-protocol', `${rel}'s never-auto-resolve list is missing '${name}'`);
      } else {
        ok();
      }
    }

    if (!text.includes('Recommendation')) {
      fail('rebase-protocol', `${rel}'s escalation format declares no 'Recommendation'`);
    } else {
      ok();
    }

    if (!/D<n>/.test(text)) {
      fail('rebase-protocol', `${rel}'s escalation format declares no 'D<n>' decision ID form`);
    } else {
      ok();
    }
  }

  // --- Mergeability — no review dispatched against a diff CI never validated --
  // Regression guard for #150: PR #134 was reviewed while `mergeable:
  // CONFLICTING`, so the findings were against a diff CI had never actually run
  // on — the conflict surfaced one stage later, in revise-agent. This checks
  // that review-agent reads mergeable at both points named in the plan and
  // states the no-verdict rule literally, and that both revise-agent and
  // PIPELINE.md carry the '## Rebase required' contract the fix routes through.
  {
    const reviewRel = 'plugins/port/agents/review-agent.md';
    const reviewText = readFileSync(join(root, reviewRel), 'utf8');

    for (const phrase of ['mergeable', 'CONFLICTING']) {
      if (!reviewText.includes(phrase)) {
        fail('mergeability', `${reviewRel} never reads '${phrase}'`);
      } else {
        ok();
      }
    }

    if (!reviewText.includes('no verdict is formed on a pull request that cannot be merged')) {
      fail(
        'mergeability',
        `${reviewRel} is missing the literal phrase 'no verdict is formed on a pull request that cannot be merged'`,
      );
    } else {
      ok();
    }

    const reviseRel = 'plugins/port/agents/revise-agent.md';
    const pipelineRel = 'plugins/port/docs/PIPELINE.md';
    for (const rel of [reviseRel, pipelineRel]) {
      const text = readFileSync(join(root, rel), 'utf8');
      if (!text.includes('## Rebase required')) {
        fail('mergeability', `${rel} never names the '## Rebase required' comment`);
      } else {
        ok();
      }
    }

    const pipelineText = readFileSync(join(root, pipelineRel), 'utf8');
    if (!pipelineText.includes('never on a schedule')) {
      fail('mergeability', `${pipelineRel} is missing the rebase-on-demand decision ('never on a schedule')`);
    } else {
      ok();
    }
  }

  // --- File contention — the cockpit holds overlapping dispatch, never races --
  // Regression guard for #135: #67, #61 and #52 all claimed the same three
  // files and were dispatched concurrently, so whichever pull request merged
  // first invalidated the others' rebases. This checks that the fenced
  // `files` contract exists in both PIPELINE.md and plan-agent.md, that
  // PIPELINE.md records the decision never to express a hold as a new label
  // or GitHub's dependency graph, and that SKILL.md's gate names its
  // precondition, the `<labels.prOpened>` occupied-set input, and the
  // `dispatch #N anyway` override.
  {
    const pipelineRel = 'plugins/port/docs/PIPELINE.md';
    const planAgentRel = 'plugins/port/agents/plan-agent.md';
    const skillRel = 'plugins/port/skills/pipeline/SKILL.md';

    const pipelineText = readFileSync(join(root, pipelineRel), 'utf8');
    const planAgentText = readFileSync(join(root, planAgentRel), 'utf8');
    const skillText = readFileSync(join(root, skillRel), 'utf8');

    for (const [rel, text] of [
      [pipelineRel, pipelineText],
      [planAgentRel, planAgentText],
    ]) {
      if (!text.includes('```files')) {
        fail('file-contention', `${rel} never carries the '\`\`\`files' fence tag`);
      } else {
        ok();
      }
    }

    if (!pipelineText.includes("never a new label and never GitHub's dependency graph")) {
      fail(
        'file-contention',
        `${pipelineRel} is missing the literal phrase "never a new label and never GitHub's dependency graph"`,
      );
    } else {
      ok();
    }

    if (!skillText.includes('only when no in-flight item\'s plan claims the same file')) {
      fail(
        'file-contention',
        `${skillRel} is missing the literal precondition phrase "only when no in-flight item's plan claims the same file"`,
      );
    } else {
      ok();
    }

    if (!skillText.includes('<labels.prOpened>')) {
      fail('file-contention', `${skillRel} never names '<labels.prOpened>' as part of the occupied-set input`);
    } else {
      ok();
    }

    if (!skillText.includes('dispatch #N anyway')) {
      fail('file-contention', `${skillRel} never declares the 'dispatch #N anyway' override`);
    } else {
      ok();
    }
  }
}
