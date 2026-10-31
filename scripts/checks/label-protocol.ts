import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, readJson, walk, relOf, frontmatter } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';

// --- Label transitions are compare-and-swap: `--remove-label X` exits 0 when X is absent, so
// a stale-view transition silently degrades into a bare add. pin: label-cas block ↔ PIPELINE.md
export default async function ({ expect, fail, note, ok }: Reporter) {
  const BEGIN = '<!-- label-cas:begin -->';
  const END = '<!-- label-cas:end -->';
  const extractBlock = (text: string): string | null => {
    const beginIdx = text.indexOf(BEGIN);
    const endIdx = text.indexOf(END);
    if (beginIdx === -1 || endIdx === -1) return null;
    return text.slice(beginIdx + BEGIN.length, endIdx).trim();
  };

  const pipelineText = readFileSync(join(root, 'plugins/port/docs/PIPELINE.md'), 'utf8');
  const canonicalBlock = extractBlock(pipelineText);
  expect(!(canonicalBlock === null), 'label-protocol', 'plugins/port/docs/PIPELINE.md carries no label-cas canonical copy');

  const agentsDir = join(root, 'plugins/port/agents');
  const agentFiles = walk(agentsDir).filter((f) => f.endsWith('.md'));

  const withBlock = [];
  let matched = 0;
  for (const f of agentFiles) {
    const rel = relOf(f);
    const fm = frontmatter(f) ?? {};
    const grantsBash =
      fm.tools === undefined || fm.tools.split(',').map((t) => t.trim()).includes('Bash');
    if (!grantsBash) continue;
    matched++;

    const block = extractBlock(readFileSync(f, 'utf8'));
    if (block === null) {
      fail('label-protocol', `${rel} grants Bash but is missing the label-cas markers`);
    } else {
      withBlock.push({ rel, block });
      expect(!(canonicalBlock !== null && block !== canonicalBlock), 'label-protocol', `${rel}'s label-cas block has drifted from PIPELINE.md's canonical copy`);
    }
  }

  expect(!(matched < 4), 'label-protocol', `only ${matched} agent(s) granting Bash matched under plugins/port/agents — expected at least 4`);

  // Every --remove-label occurrence under plugins/port/agents/ is in a file carrying the block.
  const blockRels = new Set(withBlock.map((b) => b.rel));
  for (const f of agentFiles) {
    const rel = relOf(f);
    const text = readFileSync(f, 'utf8');
    expect(!(text.includes('--remove-label') && !blockRels.has(rel)), 'label-protocol', `${rel} issues --remove-label but carries no label-cas block`);
  }

  // --- Label-cas carve-outs agree with data/labels.json: every marker-role label must be
  // named, and the sanctioned co-presence pair is exactly refreshBranch/refreshing. ---
  if (canonicalBlock !== null) {
    const canonical = canonicalBlock;
    const markerKeys = readJson('plugins/port/data/labels.json')
      .labels.filter((l: any) => l.role === 'marker')
      .map((l: any) => l.key);
    for (const key of markerKeys) {
      expect(canonical.includes(`<labels.${key}>`), 'label-protocol', `label-cas block does not name marker label '<labels.${key}>', which data/labels.json declares role: "marker"`);
    }
    expect(!(!canonical.includes('<labels.refreshBranch>') || !canonical.includes('<labels.refreshing>')), 'label-protocol', 'label-cas block does not name the sanctioned co-presence pair <labels.refreshBranch>/<labels.refreshing>');

    // The failure-direction phrase is present literally, not paraphrased, so a reverting edit fails here rather than in a live pipeline run.
    expect(canonical.includes('fails closed on the write and open on the report'), 'label-protocol', 'label-cas block is missing the literal phrase "fails closed on the write and open on the report"');
  } else {
    note('label-protocol: no label-cas block found anywhere — skipped the carve-out and failure-direction checks');
  }

  // impl-agent's existing-work pre-flight: a second run against an issue with an open pull request must abort rather than re-implement.
  {
    const rel = 'plugins/port/agents/impl-agent.md';
    const text = readFileSync(join(root, rel), 'utf8');
    expect(!(!text.includes('gh pr list') || !text.includes('--state open')), 'label-protocol', `${rel}'s Pre-flight is missing the existing-work lookup ('gh pr list ... --state open')`);
    expect(text.includes('already has an open pull request'), 'label-protocol', `${rel}'s Pre-flight is missing the existing-work abort message`);
  }

  // --- Resume from a pushed branch — a killed impl-agent run must never discard every
  // commit along with its ephemeral worktree before anything pushed. ---
  {
    const rel = 'plugins/port/agents/impl-agent.md';
    const text = readFileSync(join(root, rel), 'utf8');

    const preflightIdx = text.indexOf('## Pre-flight');
    const labelSwapIdx = text.indexOf('## Label swap (first action after pre-flight)');
    const lsRemoteIdx = text.indexOf('git ls-remote --heads origin');
    expect(!(preflightIdx === -1 ||
    labelSwapIdx === -1 ||
    lsRemoteIdx === -1 ||
    !(preflightIdx < lsRemoteIdx && lsRemoteIdx < labelSwapIdx)), 'label-protocol', `${rel}'s Pre-flight is missing the resume-branch lookup ('git ls-remote --heads origin')`);

    // The first checkpoint push must land before the checks step, since a killed run never reaches a push gated behind every check passing.
    const firstPushIdx = text.indexOf('git push');
    const runChecksIdx = text.indexOf('**Run the checks.**');
    expect(!(firstPushIdx === -1 || runChecksIdx === -1 || !(firstPushIdx < runChecksIdx)), 'label-protocol', `${rel} does not push a checkpoint before its 'Run the checks' step — a killed run must leave a pushed branch behind it`);

    expect(text.includes('every failure in the resume path degrades to a fresh start'), 'label-protocol', `${rel} is missing the literal phrase "every failure in the resume path degrades to a fresh start"`);

    // The branch a desktop-started session is already on overrides the lookup, so it must be read before the label swap.
    const showCurrentIdx = text.indexOf('git branch --show-current');
    expect(!(preflightIdx === -1 ||
    labelSwapIdx === -1 ||
    showCurrentIdx === -1 ||
    !(preflightIdx < showCurrentIdx && showCurrentIdx < labelSwapIdx) ||
    !text.includes('session branch')), 'label-protocol', `${rel}'s Pre-flight is missing the session-branch read ('git branch --show-current', between Pre-flight and Label swap)`);
  }
  {
    const rel = 'plugins/port/skills/implement/SKILL.md';
    const text = readFileSync(join(root, rel), 'utf8');
    expect(text.includes('git ls-remote --heads origin'), 'label-protocol', `${rel} does not name the same 'git ls-remote --heads origin' resume-branch lookup impl-agent.md's Pre-flight uses — the dispatched and operator routes have drifted apart`);
  }

  // --- The surviving trigger is now stripped at refresh entry, not at escalation. ---
  {
    const rel = 'plugins/port/agents/revise-agent.md';
    const text = readFileSync(join(root, rel), 'utf8');
    expect(text.includes('a pre-#494 leftover'), 'label-protocol', `${rel}'s Refresh mode swap does not strip a leftover <labels.readyForReview>/<labels.needsRevision> at entry (#225, #494)`);
  }

  // --- Refresh mode must always exit with exactly one trigger label, never none. ---
  {
    const rel = 'plugins/port/agents/revise-agent.md';
    const text = readFileSync(join(root, rel), 'utf8');
    expect(text.includes('Refresh mode never exits leaving the pull request without a trigger label (#494).'), 'label-protocol', `${rel} is missing the literal regression sentence for #494`);
  }
  {
    const rel = 'plugins/port/agents/review-agent.md';
    const text = readFileSync(join(root, rel), 'utf8');
    expect(!text.includes('<labels.readyForReview>,<labels.refreshBranch>'), 'label-protocol', `${rel}'s mergeability exit still pairs <labels.readyForReview> with <labels.refreshBranch> — #494 narrows the add to <labels.refreshBranch> alone`);
  }
}
