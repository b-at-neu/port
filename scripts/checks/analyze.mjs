import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../lib/files.mjs';

// Regression guard for #50: /port:analyze's step 6 recommended plugins on
// three bad criteria — "already installed" measured against the operator's
// own machine rather than this repository's declarations, tier 3 skipped on
// "small, simple stack", and no distinction between a plugin that reaches a
// dispatched agent and one that only helps the operator's own session. Each
// pin below is the literal phrase (or absent phrase) that constitutes the
// fix, so a future prose edit that quietly reverts one of the three fails
// here rather than in a live /port:analyze run.
export default async function ({ fail, note, ok }) {
  const skillRel = 'plugins/port/skills/analyze/SKILL.md';
  const text = readFileSync(join(root, skillRel), 'utf8');

  // --- Fix 2: tier 3 is unconditional ------------------------------------------
  for (const phrase of ['Tier 3 runs every time', 'Codebase size and stack simplicity are never reasons to skip it']) {
    if (!text.includes(phrase)) {
      fail('analyze-tier3', `${skillRel} no longer says "${phrase}" — tier 3 can be skipped again on a size/simplicity judgment`);
    } else {
      ok();
    }
  }

  // --- Fix 3: delivery-surface criterion and its ordering label ---------------
  if (!text.includes('Nobody types a command at them')) {
    fail('analyze-delivery-surface', `${skillRel} no longer states the delivery-surface criterion ("Nobody types a command at them")`);
  } else {
    ok();
  }
  if (!text.includes('operator-facing')) {
    fail('analyze-delivery-surface', `${skillRel} no longer labels command-only recommendations "operator-facing"`);
  } else {
    ok();
  }

  // --- Fix 1: exclusion is scope-aware, not machine-wide -----------------------
  if (!text.includes('already declared at project scope in this repository')) {
    fail('analyze-scope-exclusion', `${skillRel} no longer scopes exclusion to this repository's own project-scope declarations`);
  } else {
    ok();
  }
  if (text.includes('Exclude anything already installed')) {
    fail('analyze-scope-exclusion', `${skillRel} still carries the machine-wide "Exclude anything already installed" rule this ticket replaced`);
  } else {
    ok();
  }

  // --- Delivery table parses, with an affirmative Skills row -------------------
  // A hand-edited table is exactly the kind of change a reviewer skims past —
  // assert its shape rather than trusting the prose around it.
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
      if (!components.includes(expected)) {
        fail('analyze-delivery-table', `${skillRel}'s delivery table is missing a "${expected}" row`);
      } else {
        ok();
      }
    }
    const skillsRow = rows.find((r) => r[0] === 'Skills');
    if (skillsRow && !skillsRow[1]?.startsWith('Yes')) {
      fail('analyze-delivery-table', `${skillRel}'s Skills row must read affirmative ("Yes — ...") now that Skill is allowlisted`);
    } else if (skillsRow) {
      ok();
    }
  }

  note('analyze: step 6 prose pins for #50 — scope-aware exclusion, unconditional tier 3, delivery-surface criterion, delivery table shape');
}
