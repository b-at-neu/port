import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, readJson, walk, relOf, frontmatter } from '../lib/files.mjs';

// --- Label transitions are compare-and-swap ---------------------------------
// guard(#209): `gh issue edit`/`gh pr edit --remove-label X` exits 0 when X
// is not present, so a transition issued against a stale view of an item's
// labels silently degrades into a bare add and leaves two contradictory
// stage labels behind (Route 2 and Route 3). Every agent granting Bash must
// carry the byte-identical `label-cas` block that turns every
// `--remove-label` into a checked precondition. There is no PIPELINE.md
// canonical copy today — issue 177's file-size ratchet forbids that file
// growing until issue 181 frees the headroom — so the four agent copies are
// compared pairwise against each other instead of against one source.
export default async function ({ fail, note, ok }) {
  const BEGIN = '<!-- label-cas:begin -->';
  const END = '<!-- label-cas:end -->';
  const extractBlock = (text) => {
    const beginIdx = text.indexOf(BEGIN);
    const endIdx = text.indexOf(END);
    if (beginIdx === -1 || endIdx === -1) return null;
    return text.slice(beginIdx + BEGIN.length, endIdx).trim();
  };

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
      ok();
    }
  }

  if (matched < 4) {
    fail('label-protocol', `only ${matched} agent(s) granting Bash matched under plugins/port/agents — expected at least 4`);
  } else {
    ok();
  }

  // Pairwise byte-identity — no external canonical to diff against.
  for (let i = 1; i < withBlock.length; i++) {
    if (withBlock[i].block !== withBlock[0].block) {
      fail(
        'label-protocol',
        `${withBlock[i].rel}'s label-cas block has drifted from ${withBlock[0].rel}'s`,
      );
    } else {
      ok();
    }
  }

  // Every --remove-label occurrence under plugins/port/agents/ is in a file
  // carrying the block — an agent that writes through a stale view without
  // ever reading this contract is exactly the gap #209 found.
  const blockRels = new Set(withBlock.map((b) => b.rel));
  for (const f of agentFiles) {
    const rel = relOf(f);
    const text = readFileSync(f, 'utf8');
    if (text.includes('--remove-label') && !blockRels.has(rel)) {
      fail('label-protocol', `${rel} issues --remove-label but carries no label-cas block`);
    } else {
      ok();
    }
  }

  // --- Label-cas carve-outs and existing-work pre-flight ---------------------
  // guard(#209): the block's carve-outs agree with templates/labels.json,
  // both directions — every marker-role label must be named, and the
  // sanctioned co-presence pair is exactly refreshBranch/refreshing — so a
  // new marker label fails this check until the block is updated to name it,
  // and impl-agent.md's Pre-flight still runs the existing-work lookup that
  // stops a second implementation duplicating a pull request that already
  // covers the same issue.
  if (withBlock.length > 0) {
    const canonical = withBlock[0].block;
    const markerKeys = readJson('plugins/port/templates/labels.json')
      .labels.filter((l) => l.role === 'marker')
      .map((l) => l.key);
    for (const key of markerKeys) {
      if (!canonical.includes(`<labels.${key}>`)) {
        fail(
          'label-protocol',
          `label-cas block does not name marker label '<labels.${key}>', which templates/labels.json declares role: "marker"`,
        );
      } else {
        ok();
      }
    }
    if (!canonical.includes('<labels.refreshBranch>') || !canonical.includes('<labels.refreshing>')) {
      fail(
        'label-protocol',
        'label-cas block does not name the sanctioned co-presence pair <labels.refreshBranch>/<labels.refreshing>',
      );
    } else {
      ok();
    }

    // The failure-direction phrase (#209, docs/ENGINEERING.md §4) is present
    // literally, not paraphrased, so a future edit that loses the direction
    // fails here rather than in a live pipeline run.
    if (!canonical.includes('fails closed on the write and open on the report')) {
      fail(
        'label-protocol',
        'label-cas block is missing the literal phrase "fails closed on the write and open on the report"',
      );
    } else {
      ok();
    }
  } else {
    note('label-protocol: no label-cas block found anywhere — skipped the carve-out and failure-direction checks');
  }

  // impl-agent's existing-work pre-flight (#209 Route 1): a second run
  // against an issue that already has an open pull request must abort rather
  // than re-implement.
  {
    const rel = 'plugins/port/agents/impl-agent.md';
    const text = readFileSync(join(root, rel), 'utf8');
    if (!text.includes('gh pr list') || !text.includes('--state open')) {
      fail('label-protocol', `${rel}'s Pre-flight is missing the existing-work lookup ('gh pr list ... --state open')`);
    } else {
      ok();
    }
    if (!text.includes('already has an open pull request')) {
      fail('label-protocol', `${rel}'s Pre-flight is missing the existing-work abort message`);
    } else {
      ok();
    }
  }

  // revise-agent's refresh escalation removes the surviving trigger too
  // (#225): the additive-only refresh write left a ready-for-review pull
  // request carrying `ready for review` + `refresh branch` + `needs human`
  // once escalated — three role-bearing labels at once. Refresh mode's own
  // escalation step must name removing <labels.readyForReview> alongside the
  // <labels.refreshing>/<labels.approved> pair it already named.
  // guard(#225): a refresh escalation leaving `needs human` beside a live
  // trigger — three role-bearing labels at once.
  {
    const rel = 'plugins/port/agents/revise-agent.md';
    const text = readFileSync(join(root, rel), 'utf8');
    if (!text.includes('plus `<labels.readyForReview>` when it is present too')) {
      fail('label-protocol', `${rel}'s Refresh mode escalation does not name removing the surviving trigger label (<labels.readyForReview>) alongside <labels.refreshing>/<labels.approved> (#225)`);
    } else {
      ok();
    }
  }
}
