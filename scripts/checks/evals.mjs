import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { root, readJson, walk, relOf } from '../lib/files.mjs';

export default async function ({ fail, ok }) {
  // --- Eval cases are structurally sound --------------------------------------
  // Everything statically knowable about a layer 3 case is checked here, for free,
  // so a broken case is caught without an API key or early access. Presence and
  // shape only, by regex — same reasoning as the frontmatter reader above.
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

  // --- Behavioural evals never enter commands.checks --------------------------
  // The mechanical form of the ticket's own last rule. `commands.checks` is what
  // impl-agent runs before pushing, so an eval or an audit there means every
  // dispatched agent spawning model runs, or shelling out to `gh` it cannot reach.
  {
    const banned = [
      [/plugin\s+eval/, 'a behavioural eval'],
      [/artifacts\.mjs/, 'the artifact validator (audit shells out to `gh`; neither mode belongs in commands.checks)'],
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
}
