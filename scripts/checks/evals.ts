import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { root, readJson, walk, relOf, blockScalar, sectionText } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

/** Every key a case.yaml may declare, read live from evals/README.md's own
 *  schema table (its "Key" column) rather than transcribed here — a second,
 *  hand-typed copy of that table is exactly the kind of duplicate
 *  docs/ENGINEERING.md §2 requires a mechanical pin for, and the cheaper fix
 *  is to have only one copy at all. The `max_turns, timeout_seconds` row
 *  packs two backtick-quoted keys into one cell, so every backtick token in
 *  the column is taken, not just the row's first. */
function readmeSchemaKeys(readmeText: string): string[] {
  const schemaSection = sectionText(readmeText, 'The case schema, and where it came from');
  const keys: string[] = [];
  for (const row of schemaSection.matchAll(/^\|\s*((?:`[a-zA-Z_]+`,?\s*)+)\|/gm)) {
    for (const m of row[1].matchAll(/`([a-zA-Z_]+)`/g)) keys.push(m[1]);
  }
  return keys;
}

export default async function ({ fail, ok }: Reporter) {
  // --- Eval cases are structurally sound --------------------------------------
  // guard: a layer 3 case broken by a rename, invisible while the evals
  // cannot run. Everything statically knowable about a case is checked here,
  // for free, so a broken case is caught without an API key or early access.
  // Presence and shape only, by regex — same reasoning as the frontmatter
  // reader above.
  {
    const caseFiles = walk(join(root, 'evals')).filter((f) => basename(f) === 'case.yaml');
    if (caseFiles.length === 0) {
      fail('evals', 'no evals/*/case.yaml found — layer 3 cases exist as files even before they can run');
    }

    const referenced = new Set();
    for (const f of caseFiles) {
      const rel = relOf(f);
      const text = readFileSync(f, 'utf8');
      for (const key of ['name', 'prompt', 'graders']) {
        if (!new RegExp(`^${key}:`, 'm').test(text)) {
          fail('evals', `${rel} is missing '${key}'`);
        }
      }
      // `graders:` is a block list — take the `- item` lines that follow it.
      const block = /^graders:[^\n]*\n((?:[ \t]+-[^\n]*\n?)*)/m.exec(text);
      const named = [...(block?.[1] ?? '').matchAll(/^[ \t]+-\s*(.+?)\s*$/gm)].map((m) => m[1]);
      if (block && named.length === 0) {
        fail('evals', `${rel} declares 'graders' but names none`);
      }
      for (const g of named) {
        referenced.add(g);
        if (!existsSync(join(root, 'evals/graders', g))) {
          fail('evals', `${rel} references grader '${g}', which is not a file under evals/graders/`);
        }
      }
      ok();
    }

    for (const g of walk(join(root, 'evals/graders')).filter((f) => f.endsWith('.md'))) {
      if (!referenced.has(basename(g))) {
        fail('evals', `evals/graders/${basename(g)} is referenced by no case`);
      }
    }
    ok();
  }

  // --- Case top-level keys are a subset of the README schema ------------------
  // guard(#124): an invented key (an `ablation:` field is the one the ticket
  // names explicitly) reads plausibly but no consumer of case.yaml — today's
  // interim tooling or the eventual real `claude plugin eval` — has any
  // reason to look for it, so it silently does nothing. Keeping every case's
  // keys inside the README's own schema table is what keeps that table
  // authoritative rather than aspirational.
  {
    const schemaKeys = readmeSchemaKeys(readFileSync(join(root, 'evals/README.md'), 'utf8'));
    if (schemaKeys.length === 0) {
      fail('evals-schema', "evals/README.md's case schema table produced zero keys — the table moved, or the section heading changed");
    }
    const caseFiles = walk(join(root, 'evals')).filter((f) => basename(f) === 'case.yaml');
    for (const f of caseFiles) {
      const rel = relOf(f);
      const text = readFileSync(f, 'utf8');
      const keys = [...text.matchAll(/^([a-zA-Z_]+):/gm)].map((m) => m[1]);
      for (const key of keys) {
        if (!schemaKeys.includes(key)) {
          fail('evals-schema', `${rel} declares '${key}:', which is not in evals/README.md's case schema table`);
        }
      }
      ok();
    }
  }

  // --- Behavioural evals never enter commands.checks --------------------------
  // guard: every dispatched agent spawning its own model run before it can
  // push. The mechanical form of the ticket's own last rule — `commands.checks`
  // is what impl-agent runs before pushing, so an eval or an audit there means
  // every dispatched agent spawning a model run, or shelling out to `gh` it
  // cannot reach.
  {
    const banned: [RegExp, string][] = [
      [/plugin\s+eval/, 'a behavioural eval'],
      [/artifacts\.mjs/, 'the artifact validator (audit shells out to `gh`; neither mode belongs in commands.checks)'],
      [/port-forensics\.ts/, 'the forensics engine (it reads a machine-local transcript tree outside the repository and shells out to `gh`; unavailable to a dispatched agent\'s worktree)'],
    ];
    for (const rel of ['.claude/port.config.json', 'plugins/port/templates/port.config.json']) {
      if (!existsSync(join(root, rel))) continue;
      for (const entry of readJson(rel).commands?.checks ?? []) {
        for (const cmd of [entry?.run, entry?.fix]) {
          if (typeof cmd !== 'string') continue;
          for (const [re, what] of banned) {
            if (re.test(cmd)) {
              fail('checks-scope', `${rel} runs ${what} from commands.checks (${JSON.stringify(cmd)})`);
            }
          }
        }
      }
      ok();
    }
  }

  // --- Every `claude plugin eval` invocation carries --ablation with-without --
  // guard(#124): a documented or CI command missing the flag measures Claude,
  // not port — the delta is the whole point of this layer, so an invocation
  // that silently drops it produces a number nobody should trust. Scoped to
  // fenced code blocks (markdown) and `run:` step bodies (the workflow),
  // never a bare prose mention of the subcommand name — a sentence like
  // "`claude plugin eval --help` is the exception" is documentation about the
  // command, not an invocation of it.
  {
    const files = ['evals/README.md', 'docs/TESTING.md', '.github/workflows/evals.yml'];
    for (const rel of files) {
      const text = readFileSync(join(root, rel), 'utf8');
      const isYaml = rel.endsWith('.yml');
      const blocks = isYaml
        ? [text]
        : [...text.matchAll(/```(?:bash)?\n([\s\S]*?)```/g)].map((m) => m[1]);
      for (const block of blocks) {
        for (const line of block.split('\n')) {
          if (!line.includes('claude plugin eval')) continue;
          if (line.includes('--help')) continue;
          if (!line.includes('--ablation with-without')) {
            fail('evals-ablation', `${rel}: a \`claude plugin eval\` invocation is missing --ablation with-without: ${line.trim()}`);
            continue;
          }
          const ablationValues = [...line.matchAll(/--ablation[= ](\S+)/g)].map((m) => m[1]);
          if (ablationValues.some((v) => v !== 'with-without')) {
            fail('evals-ablation', `${rel}: an --ablation value other than with-without appears: ${line.trim()}`);
          }
        }
      }
      ok();
    }
  }
}

/** Used by evals-cases.ts, which needs the same block-scalar reads this
 *  module already validated the presence of. Kept here rather than
 *  duplicated so the extraction shape (a case's `prompt:`/`scaffold_script:`
 *  blocks) can never drift between modules. */
export function readCasePrompt(text: string): string {
  return blockScalar(text, 'prompt') ?? '';
}

export function readCaseScaffold(text: string): string {
  return blockScalar(text, 'scaffold_script') ?? '';
}
