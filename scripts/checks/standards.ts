import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf, frontmatter } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// --- Standards precedence ----------------------------------------------------
// guard(#192): CLAUDE.md honored by impl-agent alone, so review-agent and
// revise-agent silently "fixed" code away from a convention the repository
// itself stated.
// Regression guard for #192: CLAUDE.md was read by impl-agent alone, so
// review-agent and revise-agent judged code against docs.engineering and
// ambient style with no visibility into a repository's own stated
// convention — a silent correctness inversion (a diff that correctly
// followed CLAUDE.md got "fixed" away from it), not just a missed read.
// Every agent granting Bash must carry the byte-identical
// `standards-precedence` block establishing CLAUDE.md > docs.engineering >
// ambient style and the commands.*/PIPELINE.md carve-out. There is no
// PIPELINE.md canonical copy — the issue 177 file-size ratchet forbids that
// file growing until issue 181 frees the headroom — so the four agent copies are
// compared pairwise against each other instead of against one source, the
// same resolution docs/ENGINEERING.md §2 records for the label-cas block.
// pin: The `standards-precedence` block ↔ its copies in the four agent files — compared pairwise, same "no `PIPELINE.md` canonical copy until issue 220 moves it there" carve-out as `label-cas`
// pin: `docs.design`'s presence in the `standards-precedence` block ↔ its copies in the four agent files, and every agent naming `docs.engineering` also naming `docs.design` (and vice versa)
export default async function ({ fail, note, ok }: Reporter) {
  const BEGIN = '<!-- standards-precedence:begin -->';
  const END = '<!-- standards-precedence:end -->';
  const extractBlock = (text: string): string | null => {
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

  // guard(#49): docs.design staying a dead field wired into only some of
  // the four agents, silently inverting precedence between the two
  // standards documents.
  // Both directions on the reference: every agent file naming
  // docs.engineering also names CLAUDE.md, and every agent file naming
  // CLAUDE.md carries the block. A fifth agent added later with only one of
  // the two fails here. #49 extends the same both-directions shape to
  // docs.design: every agent naming docs.engineering also names docs.design,
  // and vice versa, mirroring the CLAUDE.md pair exactly.
  const blockRels = new Set(withBlock.map((b) => b.rel));
  for (const f of agentFiles) {
    const rel = relOf(f);
    const text = readFileSync(f, 'utf8');
    const namesEngineering = text.includes('docs.engineering');
    const namesDesign = text.includes('docs.design');
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
    if (namesEngineering && !namesDesign) {
      fail('standards', `${rel} names docs.engineering but never docs.design`);
    } else {
      ok();
    }
    if (namesDesign && !namesEngineering) {
      fail('standards', `${rel} names docs.design but never docs.engineering`);
    } else {
      ok();
    }
  }

  // The load-bearing literals survive paraphrase: CLAUDE.md's index precedes
  // docs.engineering's, which in turn precedes docs.design's, in the
  // ordering sentence; the phrase "never a finding" is present; and the
  // commands carve-out names both commands.* and .claude/port.config.json.
  // Pulled out as a function so the self-test below can prove it actually
  // rejects a broken block before it is trusted to pass the real one.
  const literalProblems = (block: string): string[] => {
    const problems: string[] = [];
    const claudeIdx = block.indexOf('CLAUDE.md');
    const engIdx = block.indexOf('docs.engineering');
    const designIdx = block.indexOf('docs.design');
    if (claudeIdx === -1 || engIdx === -1 || claudeIdx > engIdx) {
      problems.push('CLAUDE.md does not precede docs.engineering in the ordering sentence');
    }
    if (engIdx === -1 || designIdx === -1 || engIdx > designIdx) {
      problems.push('docs.engineering does not precede docs.design in the ordering sentence');
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

  // Self-test: a check that cannot be made to fail is not a check (issue 177,
  // ENGINEERING.md §7). Four literal mutations of a known-good block, each
  // must still be rejected — CLAUDE.md/docs.engineering order reversed, the
  // carve-out deleted, "never a finding" reworded, and (#49)
  // docs.engineering/docs.design order reversed — proving literalProblems
  // can catch something before the real block is trusted to pass it.
  const GOOD =
    "Conventions come from the repository's CLAUDE.md first, then docs.engineering, then docs.design, then ambient style. " +
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

  const designOrderReversed = GOOD.replace(
    'docs.engineering, then docs.design,',
    'docs.design, then docs.engineering,',
  );
  if (literalProblems(designOrderReversed).length === 0) {
    fail('standards', 'self-test: literalProblems accepted a block with the docs.engineering/docs.design order reversed');
  } else {
    ok();
  }

  // --- Design document wiring (#49, widened #191) -----------------------------
  // guard(#49, #191): a dangling template reference or a silently narrowed
  // writable set failing only at runtime, with nothing static to catch it.
  // A dangling ${CLAUDE_PLUGIN_ROOT}/templates/... reference in analyze/SKILL.md
  // is silent at runtime — the skill just cannot find the file, with nothing
  // static to catch it. Pins the two template paths the skill references as
  // existing on disk, that its writable-set sentence still names all four
  // files (issue 191 widened this from three once step 6.5 added a fourth
  // writable — the skills generated under .claude/skills/), and that it
  // still states the docs.design skip rule.
  const skillPath = join(root, 'plugins/port/skills/analyze/SKILL.md');
  const skillText = readFileSync(skillPath, 'utf8');

  for (const ref of ['templates/ENGINEERING.template.md', 'templates/DESIGN.template.md']) {
    if (!skillText.includes(ref)) {
      fail('standards', `analyze/SKILL.md no longer references ${ref}`);
    } else if (!existsSync(join(root, 'plugins/port', ref))) {
      fail('standards', `analyze/SKILL.md references ${ref}, which does not exist on disk`);
    } else {
      ok();
    }
  }

  if (!skillText.includes('the engineering document, the design document, `.claude/port.config.json`, and the skills generated under `.claude/skills/`')) {
    fail('standards', "analyze/SKILL.md's writable-set sentence no longer names all four files");
  } else {
    ok();
  }

  if (!skillText.includes('docs.design` stays null')) {
    fail('standards', 'analyze/SKILL.md no longer states the docs.design skip rule');
  } else {
    ok();
  }

  // --- Accessibility's single home (#49) --------------------------------------
  // guard(#49): the two templates drifting into restating accessibility in
  // both places instead of the one stated home.
  // ENGINEERING.md and DESIGN.md would overlap and drift on accessibility
  // without a pinned single home. Pins both directions: ENGINEERING.template.md
  // carries the accessibility heading, DESIGN.template.md carries none, and
  // DESIGN.template.md cross-references the engineering document instead of
  // restating it.
  // pin: The `ENGINEERING.md`/`DESIGN.md` boundary statement (accessibility's single home) ↔ its copy in `templates/ENGINEERING.template.md` and `templates/DESIGN.template.md` — both directions, plus `DESIGN.template.md` carrying no Accessibility heading of its own
  const engineeringTemplate = readFileSync(
    join(root, 'plugins/port/templates/ENGINEERING.template.md'),
    'utf8',
  );
  const designTemplate = readFileSync(join(root, 'plugins/port/templates/DESIGN.template.md'), 'utf8');

  if (!/^## \d+\. Accessibility/m.test(engineeringTemplate)) {
    fail('standards', 'ENGINEERING.template.md no longer carries an Accessibility heading');
  } else {
    ok();
  }

  if (/^## \d+\. Accessibility/m.test(designTemplate)) {
    fail('standards', 'DESIGN.template.md carries its own Accessibility heading — that section has exactly one home');
  } else {
    ok();
  }

  if (!designTemplate.includes('ENGINEERING.md')) {
    fail('standards', 'DESIGN.template.md no longer cross-references ENGINEERING.md');
  } else {
    ok();
  }
}
