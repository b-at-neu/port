import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf, readJson, pipelineSkillText, pipelineDocsText } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

export default async function ({ expect, fail, ok }: Reporter) {
  // --- Review evidence gate — verdicts wait for concluded checks, never forming one while a
  // check has no conclusion, and the one carve-out conditions on the module, never a literal check name. ---
  {
    const rel = 'plugins/port/agents/review-agent.md';
    const text = readFileSync(join(root, rel), 'utf8');

    expect(text.includes('statusCheckRollup'), 'review-evidence', `${rel} never reads 'statusCheckRollup' — the evidence gate has nothing to reduce`);

    expect(text.includes('--watch'), 'review-evidence', `${rel} never uses 'gh pr checks --watch' — nothing bounds the wait for pending checks`);

    expect(text.includes('no verdict is formed while any check on the head commit is pending'), 'review-evidence', `${rel} is missing the literal phrase 'no verdict is formed while any check on the head commit is pending'`);

    expect(/modules\.approvalGate/.test(text), 'review-evidence', `${rel} never conditions the carve-out on 'modules.approvalGate'`);

    expect(text.includes('blocked — checks pending'), 'review-evidence', `${rel} never names the 'blocked — checks pending' verdict`);
  }

  // --- Generality guard — no literal CI check name in a stage prompt: a hard-coded name
  // breaks the moment a repository renames its workflow job. `skills/init/SKILL.md` is exempt — it names which check to mark required, the one legitimate literal. ---
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

  // --- Rebase protocol resolves-and-escalates, not fail-closed-and-narrate: must never abort
  // the whole rebase on one ambiguous hunk, and must escalate with a decision request, never dumped conflict markers. ---
  {
    // The rebase protocol lives in RECOVERY.md — the docs union is what this assertion must read.
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

  // --- Mergeability — no review dispatched against a diff CI never validated: a verdict must
  // never form against `mergeable: CONFLICTING`. A conflicting pull request is refreshed, never sent to needs-revision, so this pins '<labels.refreshBranch>' at the mergeability exit. ---
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

  // --- Refresh is the bounded route for a stale branch: the same-SHA guard, the per-tick and
  // per-pull-request caps, and the review-cycle exemption must stay documented, not merely implemented. ---
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

  // --- File contention — the cockpit holds overlapping dispatch, never races: two plans
  // claiming the same file must never dispatch concurrently, and the hold predicate narrows to enough shared, non-excused paths via `concurrency`, never any shared path at all. ---
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

    // The '## Changes' fence-tag example lives in FORMATS.md — the docs union is what this half of the pin must read.
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
