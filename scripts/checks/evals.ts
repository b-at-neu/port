import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { root, readJson, walk, relOf, blockScalar, sectionText } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

/** Every key a case.yaml may declare, read live from evals/README.md's own schema table
 *  rather than transcribed here. One row packs two backtick-quoted keys into one cell, so every backtick token is taken, not just the first. */
function readmeSchemaKeys(readmeText: string): string[] {
  const schemaSection = sectionText(readmeText, 'The case schema, and where it came from');
  const keys: string[] = [];
  for (const row of schemaSection.matchAll(/^\|\s*((?:`[a-zA-Z_]+`,?\s*)+)\|/gm)) {
    for (const m of row[1].matchAll(/`([a-zA-Z_]+)`/g)) keys.push(m[1]);
  }
  return keys;
}

export default async function ({ fail, ok }: Reporter) {
  // --- Eval cases are structurally sound — a broken case is caught without an API key or early access. ---
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

  // --- Case top-level keys are a subset of the README schema — an invented key reads
  // plausibly but no consumer of case.yaml looks for it, silently doing nothing. ---
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

  // --- Behavioural evals never enter commands.checks — that list is what impl-agent runs
  // before pushing, so an eval there means every dispatched agent spawning its own model run. ---
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

  // --- Every `claude plugin eval` invocation carries --ablation with-without — a command
  // missing the flag measures Claude, not port. Scoped to code blocks and `run:` bodies, never a bare prose mention. ---
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

/** Used by evals-cases.ts; kept here rather than duplicated so the extraction shape can never drift between modules. */
export function readCasePrompt(text: string): string {
  return blockScalar(text, 'prompt') ?? '';
}

export function readCaseScaffold(text: string): string {
  return blockScalar(text, 'scaffold_script') ?? '';
}
