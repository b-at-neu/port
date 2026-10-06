import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf, readJson, pipelineSkillText, pipelineDocsText } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

export default async function ({ expect, fail, ok }: Reporter) {
  // --- Review evidence gate — verdicts wait for concluded checks --------------
  // guard(#143): a verdict formed before its evidence exists, and a carve-out
  // hard-coded to one repository's check names. review-agent could form a
  // verdict before the head commit's own artifact check had concluded — a
  // check with no conclusion is pending, not passing, but was read as
  // passing. This checks that the agent definition actually says to wait,
  // names the timeout verdict, and conditions the one carve-out on the
  // module that installs it, rather than a literal check name that would
  // break the moment a repository renamed its workflow job.
  {
    const rel = 'plugins/port/agents/review-agent.md';
    const text = readFileSync(join(root, rel), 'utf8');

    expect(text.includes('statusCheckRollup'), 'review-evidence', `${rel} never reads 'statusCheckRollup' — the evidence gate has nothing to reduce`);

    expect(text.includes('--watch'), 'review-evidence', `${rel} never uses 'gh pr checks --watch' — nothing bounds the wait for pending checks`);

    expect(text.includes('no verdict is formed while any check on the head commit is pending'), 'review-evidence', `${rel} is missing the literal phrase 'no verdict is formed while any check on the head commit is pending'`);

    expect(/modules\.approvalGate/.test(text), 'review-evidence', `${rel} never conditions the carve-out on 'modules.approvalGate'`);

    expect(text.includes('blocked — checks pending'), 'review-evidence', `${rel} never names the 'blocked — checks pending' verdict`);
  }

  // --- Generality guard — no literal CI check name in a stage prompt ----------
  // guard(#143): a carve-out hard-coded to one repository's check names.
  // Hard-coding a check name (rather than deriving the one excused check
  // from approval-check.yml's own jobs: key) breaks the moment a repository
  // renames its workflow job or runs a different CI setup. `skills/init/
  // SKILL.md` is deliberately exempt — it tells the operator which check to
  // mark required, which is the one legitimate literal.
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
  // guard(#143): the rebase protocol regressing to fail-closed-and-narrate
  // instead of resolve-and-escalate-as-options. A protocol that aborts the
  // whole rebase on any single ambiguous hunk discards the correct
  // resolution of every other one, and escalating by dumping conflict
  // markers at a human who was never going to open an editor is unhelpful.
  // This checks that the widened auto-resolvable rows and the
  // decision-request escalation format are both still present.
  {
    // issue 181: the rebase protocol moved from PIPELINE.md into RECOVERY.md — the
    // docs union is what this assertion must read now.
    const rel = 'plugins/port/docs/*.md';
    const text = pipelineDocsText();

    for (const phrase of ['take the union', 'deterministic order', 'apply the addition inside the new structure']) {
      expect(text.includes(phrase), 'rebase-protocol', `${rel} is missing the auto-resolvable phrase '${phrase}'`);
    }

    for (const name of ['sessionRequiredPaths', 'migration', 'environment', 'build configuration']) {
      expect(text.includes(name), 'rebase-protocol', `${rel}'s never-auto-resolve list is missing '${name}'`);
    }

    expect(text.includes('Recommendation'), 'rebase-protocol', `${rel}'s escalation format declares no 'Recommendation'`);

    expect(/D<n>/.test(text), 'rebase-protocol', `${rel}'s escalation format declares no 'D<n>' decision ID form`);
  }

  // --- Mergeability — no review dispatched against a diff CI never validated --
  // guard(#150): a verdict formed, or a rebase scheduled speculatively,
  // against a diff GitHub never actually validated. Pull request 134 was
  // reviewed while `mergeable: CONFLICTING`, so the findings were against a
  // diff CI had never actually run on — the conflict surfaced one stage
  // later, in revise-agent. This checks that review-agent reads mergeable at
  // both points named in the plan and states the no-verdict rule literally,
  // and that both revise-agent and PIPELINE.md carry the '## Rebase required'
  // contract the fix routes through. Issue 189 retargeted the route itself: a
  // conflicting pull request is refreshed, never sent to needs-revision, so
  // this now pins '<labels.refreshBranch>' at review-agent's mergeability
  // exit rather than '<labels.needsRevision>'.
  {
    const reviewRel = 'plugins/port/agents/review-agent.md';
    const reviewText = readFileSync(join(root, reviewRel), 'utf8');

    for (const phrase of ['mergeable', 'CONFLICTING']) {
      expect(reviewText.includes(phrase), 'mergeability', `${reviewRel} never reads '${phrase}'`);
    }

    expect(reviewText.includes('no verdict is formed on a pull request that cannot be merged'), 'mergeability', `${reviewRel} is missing the literal phrase 'no verdict is formed on a pull request that cannot be merged'`);

    expect(reviewText.includes('<labels.refreshBranch>'), 'mergeability', `${reviewRel} never routes its mergeability exit to '<labels.refreshBranch>'`);

    const pipelineRel = 'plugins/port/docs/PIPELINE.md';
    for (const [rel, text] of [[reviewRel, reviewText], [pipelineRel, readFileSync(join(root, pipelineRel), 'utf8')]]) {
      expect(text.includes('## Rebase required'), 'mergeability', `${rel} never names the '## Rebase required' comment`);
    }

    const pipelineText = readFileSync(join(root, pipelineRel), 'utf8');
    expect(pipelineText.includes('never on a schedule'), 'mergeability', `${pipelineRel} is missing the rebase-on-demand decision ('never on a schedule')`);
  }

  // --- Refresh is the bounded route for a stale branch ------------------------
  // guard(#189): refresh's bounds — the same-SHA guard, the per-tick and
  // per-pull-request caps, and the review-cycle exemption — regressing to
  // prose with nothing checking it, now that this issue made refresh the
  // pipeline's only rebase route. Deleting modules.previewDatabase promoted
  // refresh mode from an off-by-default subsystem to the pipeline's only
  // rebase route, so its bounds and its no-cycle-cost accounting must
  // actually be documented, not merely implemented.
  {
    const labels = readJson('plugins/port/data/labels.json');
    for (const key of ['refreshBranch', 'refreshing']) {
      const entry = labels.labels.find((l: any) => l.key === key);
      expect(!(!entry || entry.module !== 'core'), 'refresh-bounded', `labels.json's '${key}' entry must be module 'core', got ${JSON.stringify(entry?.module)}`);
    }

    const pipelineRel = 'plugins/port/docs/PIPELINE.md';
    const skillRel = 'plugins/port/skills/pipeline/*.md';
    const pipelineText = readFileSync(join(root, pipelineRel), 'utf8');
    const skillText = pipelineSkillText();

    for (const [rel, text] of [[pipelineRel, pipelineText], [skillRel, skillText]]) {
      expect(text.includes('a refresh consumes no review cycle'), 'refresh-bounded', `${rel} is missing the literal phrase 'a refresh consumes no review cycle'`);
    }

    for (const phrase of [
      'never refresh a head SHA this session already refreshed',
      'at most 5 refreshes per tick, oldest first',
      'at most 3 consecutive refreshes per pull request',
      'leaves `<labels.approved>` in place',
    ]) {
      expect(skillText.includes(phrase), 'refresh-bounded', `${skillRel} is missing the literal phrase '${phrase}'`);
    }

    expect(pipelineText.includes('never on a schedule'), 'refresh-bounded', `${pipelineRel} is missing the rebase-on-demand decision ('never on a schedule')`);
  }

  // --- File contention — the cockpit holds overlapping dispatch, never races --
  // guard(#135, #190): two plans claiming the same file dispatched
  // concurrently so whichever pull request merges first invalidates the
  // other's rebase, and a gate that held on any shared path — including
  // append-mostly registries and docs a rebase resolves as a union —
  // serialized 23 of 27 overlapping pull request pairs that could have run
  // in parallel. Issues 67, 61 and 52 all claimed the same three files and
  // were dispatched concurrently, so whichever pull request merged first
  // invalidated the others' rebases; #190 narrowed the predicate from any
  // shared path to enough shared, non-excused paths, via `concurrency`. This
  // checks that the fenced `files` contract exists in both PIPELINE.md and
  // plan-agent.md, that the schema and template carry both `concurrency`
  // keys with their documented default and minimum, that PIPELINE.md and
  // SKILL.md each name both keys and record the decision never to express a
  // hold as a new label or GitHub's dependency graph, that PIPELINE.md states
  // its fail-open direction, and that SKILL.md's gate names its reworded
  // precondition, the depth rule, the `<labels.prOpened>` occupied-set input,
  // and the `dispatch #N anyway` override.
  {
    const pipelineRel = 'plugins/port/docs/PIPELINE.md';
    const docsRel = 'plugins/port/docs/*.md';
    const planAgentRel = 'plugins/port/agents/plan-agent.md';
    const skillRel = 'plugins/port/skills/pipeline/*.md';
    const schemaRel = 'schema/port.config.schema.json';
    const templateRel = 'plugins/port/templates/port.config.json';

    const pipelineText = readFileSync(join(root, pipelineRel), 'utf8');
    const planAgentText = readFileSync(join(root, planAgentRel), 'utf8');
    const skillText = pipelineSkillText();
    const schemaText = readFileSync(join(root, schemaRel), 'utf8');
    const templateText = readFileSync(join(root, templateRel), 'utf8');

    // issue 181: the '## Changes' fence-tag example moved from PIPELINE.md into
    // FORMATS.md — the docs union is what this half of the pin must read.
    const docsText = pipelineDocsText();
    expect(docsText.includes('```files'), 'file-contention', `${docsRel} never carries the '\`\`\`files' fence tag`);
    expect(planAgentText.includes('```files'), 'file-contention', `${planAgentRel} never carries the '\`\`\`files' fence tag`);

    expect((schemaText.includes('"sharedFiles"') && schemaText.includes('"overlapThreshold"')), 'file-contention', `${schemaRel} is missing 'concurrency.sharedFiles' or 'concurrency.overlapThreshold'`);

    expect((schemaText.includes('"default": 2') && schemaText.includes('"minimum": 1')), 'file-contention', `${schemaRel}'s 'concurrency.overlapThreshold' is missing its documented 'default: 2' or 'minimum: 1'`);

    expect((templateText.includes('sharedFiles') && templateText.includes('overlapThreshold')), 'file-contention', `${templateRel} never ships the 'concurrency' defaults`);

    for (const [rel, text] of [
      [pipelineRel, pipelineText],
      [skillRel, skillText],
    ]) {
      expect((text.includes('concurrency.sharedFiles') && text.includes('concurrency.overlapThreshold')), 'file-contention', `${rel} never names both 'concurrency.sharedFiles' and 'concurrency.overlapThreshold'`);
    }

    expect(pipelineText.includes("never a new label and never GitHub's dependency graph"), 'file-contention', `${pipelineRel} is missing the literal phrase "never a new label and never GitHub's dependency graph"`);

    expect(pipelineText.includes('fails open toward dispatch'), 'file-contention', `${pipelineRel} is missing the literal phrase "fails open toward dispatch"`);

    const reworded = 'only when no single in-flight item\'s plan claims concurrency.overlapThreshold or more of the same non-shared files';
    expect(skillText.replaceAll('`', '').includes(reworded), 'file-contention', `${skillRel} is missing the reworded precondition phrase "${reworded}"`);

    expect(skillText.includes('counted per in-flight item, never pooled'), 'file-contention', `${skillRel} is missing the literal phrase "counted per in-flight item, never pooled"`);

    expect(skillText.includes('<labels.prOpened>'), 'file-contention', `${skillRel} never names '<labels.prOpened>' as part of the occupied-set input`);

    expect(skillText.includes('dispatch #N anyway'), 'file-contention', `${skillRel} never declares the 'dispatch #N anyway' override`);
  }
}
