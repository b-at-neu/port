import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf, frontmatter } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// --- Standards precedence: every Bash-granting agent carries the byte-identical
// `standards-precedence` block. pin: that block ↔ its canonical copy in PIPELINE.md, and `docs.design`'s presence ↔ `docs.engineering`'s, both directions.
export default async function ({ expect, fail, note, ok }: Reporter) {
  const BEGIN = '<!-- standards-precedence:begin -->';
  const END = '<!-- standards-precedence:end -->';
  const extractBlock = (text: string): string | null => {
    const beginIdx = text.indexOf(BEGIN);
    const endIdx = text.indexOf(END);
    if (beginIdx === -1 || endIdx === -1) return null;
    return text.slice(beginIdx + BEGIN.length, endIdx).trim();
  };

  const pipelineText = readFileSync(join(root, 'plugins/port/docs/PIPELINE.md'), 'utf8');
  const canonicalBlock = extractBlock(pipelineText);
  expect(!(canonicalBlock === null), 'standards', 'plugins/port/docs/PIPELINE.md carries no standards-precedence canonical copy');

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
      expect(!(canonicalBlock !== null && block !== canonicalBlock), 'standards', `${rel}'s standards-precedence block has drifted from PIPELINE.md's canonical copy`);
    }
  }

  expect(!(matched < 4), 'standards', `only ${matched} agent(s) granting Bash matched under plugins/port/agents — expected at least 4`);

  // Both directions: every agent naming docs.engineering also names CLAUDE.md and docs.design, and vice versa — a fifth agent with only one of the pair fails here.
  const blockRels = new Set(withBlock.map((b) => b.rel));
  for (const f of agentFiles) {
    const rel = relOf(f);
    const text = readFileSync(f, 'utf8');
    const namesEngineering = text.includes('docs.engineering');
    const namesDesign = text.includes('docs.design');
    const namesClaudeMd = text.includes('CLAUDE.md');
    expect(!(namesEngineering && !namesClaudeMd), 'standards', `${rel} names docs.engineering but never CLAUDE.md`);
    expect(!(namesClaudeMd && !blockRels.has(rel)), 'standards', `${rel} names CLAUDE.md but carries no standards-precedence block`);
    expect(!(namesEngineering && !namesDesign), 'standards', `${rel} names docs.engineering but never docs.design`);
    expect(!(namesDesign && !namesEngineering), 'standards', `${rel} names docs.design but never docs.engineering`);
  }

  // The load-bearing literals survive paraphrase: CLAUDE.md precedes docs.engineering
  // precedes docs.design, "never a finding" is present, and commands.* is the sole non-overridable exception. Pulled out so the self-test below can prove it rejects a broken block.
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
    const cmdIdx = block.indexOf('commands.*');
    const soleIdx = block.indexOf('sole non-overridable exception');
    if (cmdIdx === -1 || soleIdx === -1 || cmdIdx > soleIdx) {
      problems.push('does not name commands.* as the sole non-overridable exception');
    }
    if (!block.includes('is overridable')) {
      problems.push('does not state that every other category is overridable');
    }
    return problems;
  };

  if (canonicalBlock !== null) {
    const canonical = canonicalBlock;
    const problems = literalProblems(canonical);
    if (problems.length > 0) {
      for (const p of problems) fail('standards', `standards-precedence block: ${p}`);
    } else {
      ok();
    }
  } else {
    note('standards: no standards-precedence block found anywhere — skipped the literal checks');
  }

  // Self-test: four literal mutations of a known-good block must still be rejected, proving
  // literalProblems can catch something before the real block is trusted to pass it.
  const GOOD =
    "Conventions come from the repository's CLAUDE.md first, then docs.engineering, then docs.design, then ambient style. " +
    'commands.* and .claude/port.config.json alone decide the rest. ' +
    'commands.* is the sole non-overridable exception; every other category is overridable. ' +
    'Code that follows CLAUDE.md is never a finding, at any severity.';
  expect(!(literalProblems(GOOD).length !== 0), 'standards', 'self-test: literalProblems rejected a known-good block');

  const orderReversed = GOOD.replace(
    'CLAUDE.md first, then docs.engineering,',
    'docs.engineering first, then CLAUDE.md,',
  );
  expect(!(literalProblems(orderReversed).length === 0), 'standards', 'self-test: literalProblems accepted a block with the ordering sentence reversed');

  const carveOutDeleted = GOOD.replace(
    'commands.* and .claude/port.config.json alone decide the rest. ',
    '',
  );
  expect(!(literalProblems(carveOutDeleted).length === 0), 'standards', 'self-test: literalProblems accepted a block with the commands carve-out deleted');

  const reworded = GOOD.replace('is never a finding, at any severity', 'is not a blocking finding, at any severity');
  expect(!(literalProblems(reworded).length === 0), 'standards', 'self-test: literalProblems accepted a block with "never a finding" reworded');

  const designOrderReversed = GOOD.replace(
    'docs.engineering, then docs.design,',
    'docs.design, then docs.engineering,',
  );
  expect(!(literalProblems(designOrderReversed).length === 0), 'standards', 'self-test: literalProblems accepted a block with the docs.engineering/docs.design order reversed');

  // Two further mutations: the sole-exception phrase deleted, and the overridable statement deleted — each must still be rejected.
  const soleExceptionDeleted = GOOD.replace('commands.* is the sole non-overridable exception; every other category is overridable. ', '');
  expect(!(literalProblems(soleExceptionDeleted).length === 0), 'standards', 'self-test: literalProblems accepted a block with the sole-non-overridable-exception phrase deleted');

  const overridableStatementDeleted = GOOD.replace('every other category is overridable', 'every other category behaves how it likes');
  expect(!(literalProblems(overridableStatementDeleted).length === 0), 'standards', 'self-test: literalProblems accepted a block with no statement that the rest is overridable');

  // --- Design document wiring: a dangling template reference in analyze/SKILL.md is silent
  // at runtime — the skill just cannot find the file. Pins both template paths as existing on disk, the writable-set sentence naming all four files, and the docs.design skip rule. ---
  const skillPath = join(root, 'plugins/port/skills/analyze/SKILL.md');
  const skillText = readFileSync(skillPath, 'utf8');

  for (const ref of ['templates/ENGINEERING.template.md', 'templates/DESIGN.template.md']) {
    if (!skillText.includes(ref)) {
      fail('standards', `analyze/SKILL.md no longer references ${ref}`);
    } else expect(existsSync(join(root, 'plugins/port', ref)), 'standards', `analyze/SKILL.md references ${ref}, which does not exist on disk`);
  }

  expect(skillText.includes('the engineering document, the design document, `.claude/port.config.json`, and the skills generated under `.claude/skills/`'), 'standards', "analyze/SKILL.md's writable-set sentence no longer names all four files");

  expect(skillText.includes('docs.design` stays null'), 'standards', 'analyze/SKILL.md no longer states the docs.design skip rule');

  // pin: The `ENGINEERING.md`/`DESIGN.md` boundary statement (accessibility's single home) ↔ its copy in `templates/ENGINEERING.template.md` and `templates/DESIGN.template.md` — both directions, plus `DESIGN.template.md` carrying no Accessibility heading of its own
  const engineeringTemplate = readFileSync(
    join(root, 'plugins/port/templates/ENGINEERING.template.md'),
    'utf8',
  );
  const designTemplate = readFileSync(join(root, 'plugins/port/templates/DESIGN.template.md'), 'utf8');

  expect(/^## \d+\. Accessibility/m.test(engineeringTemplate), 'standards', 'ENGINEERING.template.md no longer carries an Accessibility heading');

  expect(!/^## \d+\. Accessibility/m.test(designTemplate), 'standards', 'DESIGN.template.md carries its own Accessibility heading — that section has exactly one home');

  expect(designTemplate.includes('ENGINEERING.md'), 'standards', 'DESIGN.template.md no longer cross-references ENGINEERING.md');
}
