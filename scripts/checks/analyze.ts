import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { root, frontmatter, parseFrontmatter } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// Each pin below is the literal phrase (or absent phrase) constituting the fix, so a future
// prose edit that quietly reverts one of the three fails here rather than in a live run.
export default async function ({ expect, fail, note, ok }: Reporter) {
  const skillRel = 'plugins/port/skills/analyze/SKILL.md';
  const text = readFileSync(join(root, skillRel), 'utf8');

  // --- Fix 2: tier 3 is unconditional ------------------------------------------
  for (const phrase of ['Tier 3 runs every time', 'Codebase size and stack simplicity are never reasons to skip it']) {
    expect(text.includes(phrase), 'analyze-tier3', `${skillRel} no longer says "${phrase}" — tier 3 can be skipped again on a size/simplicity judgment`);
  }

  // --- Fix 3: delivery-surface criterion and its ordering label ---------------
  expect(text.includes('Nobody types a command at them'), 'analyze-delivery-surface', `${skillRel} no longer states the delivery-surface criterion ("Nobody types a command at them")`);
  expect(text.includes('operator-facing'), 'analyze-delivery-surface', `${skillRel} no longer labels command-only recommendations "operator-facing"`);

  // --- Fix 1: exclusion is scope-aware, not machine-wide -----------------------
  expect(text.includes('already declared at project scope in this repository'), 'analyze-scope-exclusion', `${skillRel} no longer scopes exclusion to this repository's own project-scope declarations`);
  expect(!text.includes('Exclude anything already installed'), 'analyze-scope-exclusion', `${skillRel} still carries the machine-wide "Exclude anything already installed" rule this ticket replaced`);

  // --- Delivery table parses, with an affirmative Skills row — asserted against its shape, not the surrounding prose. ---
  const tableMatch = /\| Component \| Reaches a dispatched agent\? \|\n\|[-\s|]+\|\n((?:\|.*\|\n?)+)/.exec(text);
  if (!tableMatch) {
    fail('analyze-delivery-table', `${skillRel} is missing the delivery-surface table ("| Component | Reaches a dispatched agent? |")`);
  } else {
    const rows = tableMatch[1]
      .trim()
      .split('\n')
      .map((line) => line.split('|').map((cell) => cell.trim()).filter((cell) => cell.length > 0));
    const components = rows.map((r) => r[0]);
    for (const expected of ['MCP server', 'LSP server', 'Hooks', 'Skills', 'Slash commands']) {
      expect(components.includes(expected), 'analyze-delivery-table', `${skillRel}'s delivery table is missing a "${expected}" row`);
    }
    const skillsRow = rows.find((r) => r[0] === 'Skills');
    if (skillsRow && !skillsRow[1]?.startsWith('Yes')) {
      fail('analyze-delivery-table', `${skillRel}'s Skills row must read affirmative ("Yes — ...") now that Skill is allowlisted`);
    } else if (skillsRow) {
      ok();
    }
  }

  note('analyze: step 6 prose pins for #50 — scope-aware exclusion, unconditional tier 3, delivery-surface criterion, delivery table shape');

  // --- Skill generation (step 6.5): a dangling reference to the recipe or its templates
  // is silent at runtime — the skill just cannot find the file. ---
  {
    const recipeRel = 'plugins/port/skills/analyze/SKILL-GENERATION.md';
    const recipePath = join(root, recipeRel);
    if (!existsSync(recipePath)) {
      fail('analyze-skillgen', `${skillRel} is expected to defer to ${recipeRel}, which does not exist`);
    } else if (!text.includes('SKILL-GENERATION.md')) {
      fail('analyze-skillgen', `${skillRel} no longer references ${recipeRel}`);
    } else {
      ok();

      const recipeText = readFileSync(recipePath, 'utf8');

      for (const ref of ['templates/SCAFFOLDER.template.md', 'templates/AUDITOR.template.md']) {
        if (!recipeText.includes(ref)) {
          fail('analyze-skillgen', `${recipeRel} no longer references ${ref}`);
        } else expect(existsSync(join(root, 'plugins/port', ref)), 'analyze-skillgen', `${recipeRel} references ${ref}, which does not exist on disk`);
      }

      const scaffolderTemplates: [string, string[]][] = [
        ['plugins/port/templates/SCAFFOLDER.template.md', ['Read', 'Grep', 'Glob', 'Write', 'Edit']],
        ['plugins/port/templates/AUDITOR.template.md', ['Read', 'Grep', 'Glob']],
      ];
      for (const [templateRel, expectedTools] of scaffolderTemplates) {
        const templatePath = join(root, templateRel);
        const fm = existsSync(templatePath) ? frontmatter(templatePath) : null;
        if (!fm) {
          fail('analyze-skillgen', `${templateRel} has no --- delimited frontmatter`);
          continue;
        }
        for (const key of ['name', 'description', 'allowed-tools']) {
          expect(fm[key], 'analyze-skillgen', `${templateRel} is missing '${key}' in frontmatter`);
        }
        const declaredTools = (fm['allowed-tools'] ?? '').split(',').map((t) => t.trim()).filter(Boolean);
        for (const tool of expectedTools) {
          expect(declaredTools.includes(tool), 'analyze-skillgen', `${templateRel}'s allowed-tools is missing '${tool}'`);
        }
      }

      // A malformed or incomplete frontmatter block must fail the same shape check; exercises
      // the real shared `parseFrontmatter()`, not a hand-rolled duplicate.
      const goodFrontmatter = '---\nname: x\ndescription: y\nallowed-tools: Read, Grep, Glob\n---\n';
      const missingAllowedTools = '---\nname: x\ndescription: y\n---\n';
      const missingName = '---\ndescription: y\nallowed-tools: Read, Grep, Glob\n---\n';
      const good = parseFrontmatter(goodFrontmatter);
      const badTools = parseFrontmatter(missingAllowedTools);
      const badName = parseFrontmatter(missingName);
      expect(!(!good?.name || !good?.description || !good?.['allowed-tools']), 'analyze-skillgen', 'self-test: frontmatter parser rejected a known-good template literal');
      expect(!badTools?.['allowed-tools'], 'analyze-skillgen', 'self-test: frontmatter parser accepted a block missing allowed-tools');
      expect(!badName?.name, 'analyze-skillgen', 'self-test: frontmatter parser accepted a block missing name');

      for (const phrase of [
        'Runs after step 6',
        'never before it',
        'Propose, never write unconfirmed',
      ]) {
        expect(text.includes(phrase), 'analyze-skillgen', `${skillRel} no longer states "${phrase}" for step 6.5`);
      }

      expect(recipeText.includes('generic test'), 'analyze-skillgen', `${recipeRel} no longer names the generic test`);

      expect(recipeText.includes('${CLAUDE_PLUGIN_ROOT}/skills/'), 'analyze-skillgen', `${recipeRel} no longer resolves a name collision by reading \${CLAUDE_PLUGIN_ROOT}/skills/`);

      expect(recipeText.includes('never work from a transcribed list'), 'analyze-skillgen', `${recipeRel} no longer states the anti-transcribed-list rule`);

      // The transcribed-list guard, self-tested: a literal enumerating every shipped skill name must be caught.
      const enumeratedList =
        'The shipped skills are: analyze, implement, init, pipeline, release, scope, worktree-clean.';
      const looksLikeTranscribedList = (s: string): boolean =>
        /shipped skills are:.*analyze.*implement.*init.*pipeline.*release.*scope.*worktree-clean/is.test(s);
      if (!looksLikeTranscribedList(enumeratedList)) {
        fail('analyze-skillgen', 'self-test: transcribed-list guard did not flag a literal that enumerates every shipped skill name');
      } else expect(!looksLikeTranscribedList(recipeText), 'analyze-skillgen', `${recipeRel} carries a transcribed list of every shipped skill name — a second copy needing its own pin`);
    }
  }

  note('analyze: step 6.5 pins for #191 — recipe and template references resolve, archetype frontmatter shape, generic test named, no transcribed skill list');
}
