import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf, frontmatter } from '../lib/files.mjs';

// --- Standards precedence ----------------------------------------------------
// Regression guard for #192: CLAUDE.md was read by impl-agent alone, so
// review-agent and revise-agent judged code against docs.engineering and
// ambient style with no visibility into a repository's own stated
// convention — a silent correctness inversion (a diff that correctly
// followed CLAUDE.md got "fixed" away from it), not just a missed read.
// Every agent granting Bash must carry the byte-identical
// `standards-precedence` block establishing CLAUDE.md > docs.engineering >
// ambient style and the commands.*/PIPELINE.md carve-out. There is no
// PIPELINE.md canonical copy — the #177 file-size ratchet forbids that file
// growing until #181 frees the headroom — so the four agent copies are
// compared pairwise against each other instead of against one source, the
// same resolution docs/ENGINEERING.md §2 records for the label-cas block.
export default async function ({ fail, note, ok }) {
  const BEGIN = '<!-- standards-precedence:begin -->';
  const END = '<!-- standards-precedence:end -->';
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
      fail('standards', `${rel} grants Bash but is missing the standards-precedence markers`);
    } else {
      withBlock.push({ rel, block });
      ok();
    }
  }

  if (matched < 4) {
    fail('standards', `only ${matched} agent(s) granting Bash matched under plugins/port/agents — expected at least 4`);
  } else {
    ok();
  }

  // Pairwise byte-identity — no external canonical to diff against.
  for (let i = 1; i < withBlock.length; i++) {
    if (withBlock[i].block !== withBlock[0].block) {
      fail(
        'standards',
        `${withBlock[i].rel}'s standards-precedence block has drifted from ${withBlock[0].rel}'s`,
      );
    } else {
      ok();
    }
  }

  // Both directions on the reference: every agent file naming
  // docs.engineering also names CLAUDE.md, and every agent file naming
  // CLAUDE.md carries the block. A fifth agent added later with only one of
  // the two fails here.
  const blockRels = new Set(withBlock.map((b) => b.rel));
  for (const f of agentFiles) {
    const rel = relOf(f);
    const text = readFileSync(f, 'utf8');
    const namesEngineering = text.includes('docs.engineering');
    const namesClaudeMd = text.includes('CLAUDE.md');
    if (namesEngineering && !namesClaudeMd) {
      fail('standards', `${rel} names docs.engineering but never CLAUDE.md`);
    } else {
      ok();
    }
    if (namesClaudeMd && !blockRels.has(rel)) {
      fail('standards', `${rel} names CLAUDE.md but carries no standards-precedence block`);
    } else {
      ok();
    }
  }

  // The load-bearing literals survive paraphrase: CLAUDE.md's index precedes
  // docs.engineering's in the ordering sentence, the phrase "never a
  // finding" is present, and the commands carve-out names both commands.*
  // and .claude/port.config.json. Pulled out as a function so the self-test
  // below can prove it actually rejects a broken block before it is trusted
  // to pass the real one.
  const literalProblems = (block) => {
    const problems = [];
    const claudeIdx = block.indexOf('CLAUDE.md');
    const engIdx = block.indexOf('docs.engineering');
    if (claudeIdx === -1 || engIdx === -1 || claudeIdx > engIdx) {
      problems.push('CLAUDE.md does not precede docs.engineering in the ordering sentence');
    }
    if (!block.includes('never a finding')) {
      problems.push('missing the literal phrase "never a finding"');
    }
    if (!block.includes('commands.*') || !block.includes('.claude/port.config.json')) {
      problems.push('the commands carve-out does not name both commands.* and .claude/port.config.json');
    }
    return problems;
  };

  if (withBlock.length > 0) {
    const canonical = withBlock[0].block;
    const problems = literalProblems(canonical);
    if (problems.length > 0) {
      for (const p of problems) fail('standards', `standards-precedence block: ${p}`);
    } else {
      ok();
    }
  } else {
    note('standards: no standards-precedence block found anywhere — skipped the literal checks');
  }

  // Self-test: a check that cannot be made to fail is not a check (#177,
  // ENGINEERING.md §7). Three literal mutations of a known-good block, each
  // must still be rejected — order reversed, the carve-out deleted, and
  // "never a finding" reworded — proving literalProblems can catch something
  // before the real block is trusted to pass it.
  const GOOD =
    "Conventions come from the repository's CLAUDE.md first, then docs.engineering, then ambient style. " +
    'commands.* and .claude/port.config.json alone decide the rest. ' +
    'Code that follows CLAUDE.md is never a finding, at any severity.';
  if (literalProblems(GOOD).length !== 0) {
    fail('standards', 'self-test: literalProblems rejected a known-good block');
  } else {
    ok();
  }

  const orderReversed = GOOD.replace(
    'CLAUDE.md first, then docs.engineering,',
    'docs.engineering first, then CLAUDE.md,',
  );
  if (literalProblems(orderReversed).length === 0) {
    fail('standards', 'self-test: literalProblems accepted a block with the ordering sentence reversed');
  } else {
    ok();
  }

  const carveOutDeleted = GOOD.replace(
    'commands.* and .claude/port.config.json alone decide the rest. ',
    '',
  );
  if (literalProblems(carveOutDeleted).length === 0) {
    fail('standards', 'self-test: literalProblems accepted a block with the commands carve-out deleted');
  } else {
    ok();
  }

  const reworded = GOOD.replace('is never a finding, at any severity', 'is not a blocking finding, at any severity');
  if (literalProblems(reworded).length === 0) {
    fail('standards', 'self-test: literalProblems accepted a block with "never a finding" reworded');
  } else {
    ok();
  }
}
