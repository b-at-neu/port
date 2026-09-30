import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { root, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';
import { readCasePrompt, readCaseScaffold } from './evals.ts';

/** The dispatch sentence every agent-stage case's `prompt:` must open with,
 *  byte-identical apart from `<stage>` — the one string the ticket pins
 *  across `plan-`/`impl-`/`review-`/`revise-` cases so a case can be
 *  rewritten without silently drifting from what the cockpit actually
 *  sends. `evals/README.md`'s "Writing a case" carries the same sentence —
 *  pin: the two copies are asserted to agree below. */
const DISPATCH_SENTENCE = (stage: string) =>
  `Dispatch the \`port:${stage}-agent\` subagent and pass it the brief below, verbatim, as its prompt. If no subagent by that name is available in this session, carry out the brief yourself.`;

/** First path segment of a case name maps to the surface it must invoke, per
 *  evals/README.md's "Surface by name prefix" rule. `skill` names a
 *  directory under `plugins/port/skills/`; `agent` names the stage whose
 *  `plugins/port/agents/<stage>-agent.md` must exist and whose dispatch
 *  sentence the case's prompt must open with. */
const PREFIX_SURFACE: Record<string, { needle: string; skill?: string; agent?: string }> = {
  cockpit: { needle: '/port:pipeline', skill: 'pipeline' },
  pipeline: { needle: '/port:pipeline', skill: 'pipeline' },
  analyze: { needle: '/port:analyze', skill: 'analyze' },
  init: { needle: '/port:init', skill: 'init' },
  plan: { needle: '', agent: 'plan' },
  impl: { needle: '', agent: 'impl' },
  review: { needle: '', agent: 'review' },
  revise: { needle: '', agent: 'revise' },
};

const PRESSURE_VOCAB = ['time', 'sunk cost', 'authority', 'exhaustion', 'economic', 'social', 'pragmatic'];

function firstNonEmptyLine(block: string): string {
  return block.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
}

/** Collapses whitespace (including the hard line-wraps every prompt here
 *  uses for readability — a YAML `|` block preserves them literally, unlike
 *  markdown's own soft-wrap) so a sentence written across several source
 *  lines still compares equal to its single-line template. */
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export default async function ({ fail, ok }: Reporter) {
  const caseFiles = walk(join(root, 'evals'))
    .filter((f) => basename(f) === 'case.yaml')
    .sort();

  // --- Surface-by-prefix and mapped targets exist ------------------------------
  // guard(#124): a case dispatched at the wrong surface (or one whose target
  // skill/agent no longer exists) measures nothing real — the model answers
  // a prompt disconnected from the plugin path it claims to exercise.
  {
    for (const f of caseFiles) {
      const rel = relOf(f);
      const dirName = basename(dirname(f));
      const prefix = dirName.split('-')[0];
      const surface = PREFIX_SURFACE[prefix];
      if (!surface) {
        fail('evals-surface', `${rel}: '${prefix}-' has no mapped surface in evals/README.md's prefix table`);
        continue;
      }
      const prompt = readCasePrompt(readFileSync(f, 'utf8'));
      const firstLine = firstNonEmptyLine(prompt);

      if (surface.skill) {
        if (!firstLine.includes(surface.needle)) {
          fail('evals-surface', `${rel}: prompt's first line must contain ${surface.needle}`);
        }
        if (!existsSync(join(root, 'plugins/port/skills', surface.skill))) {
          fail('evals-surface', `${rel}: mapped target plugins/port/skills/${surface.skill}/ does not exist`);
        }
      } else if (surface.agent) {
        if (!firstLine.includes(`port:${surface.agent}-agent`)) {
          fail('evals-surface', `${rel}: prompt's first line must name \`port:${surface.agent}-agent\``);
        }
        const agentFile = join(root, `plugins/port/agents/${surface.agent}-agent.md`);
        if (!existsSync(agentFile)) {
          fail('evals-surface', `${rel}: mapped target plugins/port/agents/${surface.agent}-agent.md does not exist`);
        }
      }
      ok();
    }
  }

  // --- The dispatch sentence is byte-identical across every agent-stage case --
  // guard(#124): a paraphrased dispatch sentence silently drifts from what the
  // cockpit actually sends (pipeline/SKILL.md → Dispatching), so a case that
  // "looks like" a dispatch stops meaning one.
  // pin: `evals/README.md`'s "Writing a case" blockquote ↔ this module's
  // DISPATCH_SENTENCE template.
  {
    const readmeText = readFileSync(join(root, 'evals/README.md'), 'utf8');
    const readmeSentence = /^\s*>\s*(Dispatch the .+? yourself\.)\s*$/m.exec(readmeText)?.[1];
    if (readmeSentence !== DISPATCH_SENTENCE('<stage>')) {
      fail('evals-dispatch-sentence', "evals/README.md's dispatch-sentence blockquote no longer matches evals-cases.ts's DISPATCH_SENTENCE template");
    }
    ok();

    for (const f of caseFiles) {
      const rel = relOf(f);
      const dirName = basename(dirname(f));
      const prefix = dirName.split('-')[0];
      const surface = PREFIX_SURFACE[prefix];
      if (!surface?.agent) continue;

      const prompt = readCasePrompt(readFileSync(f, 'utf8'));
      const sentence = DISPATCH_SENTENCE(surface.agent);
      if (!normalizeWs(prompt).includes(normalizeWs(sentence))) {
        fail('evals-dispatch-sentence', `${rel}: missing the byte-identical dispatch sentence for port:${surface.agent}-agent`);
      }
      if (!/^Brief:\s*$/m.test(prompt)) {
        fail('evals-dispatch-sentence', `${rel}: no 'Brief:' line follows the dispatch sentence`);
      }
      ok();
    }
  }

  // --- Leak ban on the prompt: block -------------------------------------------
  // guard(#124): a case's prompt naming its own plugin path (or a shipped
  // doc/agent basename) hands the without-arm the very rule it exists to
  // measure the absence of — the whole ablation delta becomes meaningless
  // for that case. Header comments are exempt; only the prompt: block itself
  // reaches the model.
  {
    const bannedBasenames = ['PIPELINE.md', 'FORMATS.md', 'RECOVERY.md', 'SKILL.md', 'TICK-PROSE.md'];
    const bannedAgentFiles = ['plan-agent.md', 'impl-agent.md', 'review-agent.md', 'revise-agent.md'];
    for (const f of caseFiles) {
      const rel = relOf(f);
      const prompt = readCasePrompt(readFileSync(f, 'utf8'));
      const banned = ['plugins/port/', 'CLAUDE_PLUGIN_ROOT', ...bannedBasenames, ...bannedAgentFiles];
      for (const needle of banned) {
        if (prompt.includes(needle)) {
          fail('evals-leak', `${rel}: prompt: block leaks '${needle}'`);
        }
      }
      ok();
    }
  }

  // --- Agent-stage scaffolds write both .claude/ files -------------------------
  // guard(#124): without an allowlist, the guard hook denies every Bash call a
  // dispatched subagent's with-arm makes, grading that arm on a sandbox
  // defect (an unreachable settings file) rather than the prompt under test.
  {
    for (const f of caseFiles) {
      const rel = relOf(f);
      const dirName = basename(dirname(f));
      const prefix = dirName.split('-')[0];
      if (!PREFIX_SURFACE[prefix]?.agent) continue;

      const scaffold = readCaseScaffold(readFileSync(f, 'utf8'));
      for (const needle of ['.claude/port.config.json', '.claude/settings.json']) {
        if (!scaffold.includes(needle)) {
          fail('evals-scaffold', `${rel}: scaffold_script never writes ${needle}`);
        }
      }
      ok();
    }
  }

  // --- Pressure metadata and A/B/C lines for pressure-tagged cases -------------
  // guard(#124): a case tagged `pressure` with no real pressure combination is
  // exactly the "academic" scenario the ticket's own citation warns is too
  // weak to catch a compliance failure — the tag would claim rigor the case
  // does not have.
  {
    let pressureCount = 0;
    for (const f of caseFiles) {
      const rel = relOf(f);
      const text = readFileSync(f, 'utf8');
      const tagsLine = /^tags:\s*\[(.*)\]/m.exec(text)?.[1] ?? '';
      const tags = tagsLine.split(',').map((t) => t.trim());
      if (!tags.includes('pressure')) continue;
      pressureCount++;

      const header = text.slice(0, text.search(/^name:/m));
      const reproduces = /^#\s*Reproduces:\s*#\d+/m.test(header);
      if (!reproduces) {
        fail('evals-pressure', `${rel}: tagged 'pressure' but has no '# Reproduces: #<n>' header comment`);
      }
      const pressuresMatch = /^#\s*Pressures:\s*(.+)$/m.exec(header);
      if (!pressuresMatch) {
        fail('evals-pressure', `${rel}: tagged 'pressure' but has no '# Pressures: ...' header comment`);
      } else {
        const entries = pressuresMatch[1].split(',').map((p) => p.trim());
        const unique = new Set(entries);
        if (unique.size < 3) {
          fail('evals-pressure', `${rel}: fewer than 3 distinct pressures declared (${pressuresMatch[1]})`);
        }
        for (const e of entries) {
          if (!PRESSURE_VOCAB.includes(e)) {
            fail('evals-pressure', `${rel}: '${e}' is not in the pressure vocabulary (${PRESSURE_VOCAB.join(', ')})`);
          }
        }
      }

      const prompt = readCasePrompt(text);
      for (const letter of ['A)', 'B)', 'C)']) {
        if (!prompt.split('\n').some((l) => l.trim().startsWith(letter))) {
          fail('evals-pressure', `${rel}: tagged 'pressure' but the prompt has no line opening '${letter}'`);
        }
      }
      ok();
    }

    // --- At least five pressure-tagged cases ---------------------------------
    // guard(#124): the epic's own acceptance criterion — five pressure cases,
    // each reproducing a real failure — read as a count, not just a tag's
    // existence.
    if (pressureCount < 5) {
      fail('evals-pressure', `only ${pressureCount} case(s) tagged 'pressure' — the epic requires at least 5`);
    }
    ok();
  }
}
