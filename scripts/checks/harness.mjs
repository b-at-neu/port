import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { root, walk } from '../lib/files.mjs';

// Keeps the split (#168) honest, mechanically, so it cannot silently regress
// back into one monolith: (a) the runner may only wire modules together and
// call report() — no check logic of its own — and (b) every topic module
// that exists on disk is actually imported and run. An unimported module is
// exactly the silence layer 1 exists to catch: it runs nothing and reports
// nothing.
export default async function ({ fail, ok }) {
  const runnerRel = 'scripts/checks.mjs';
  const runnerText = readFileSync(join(root, runnerRel), 'utf8');

  if (/\b(?:fail|note|ok)\(/.test(runnerText)) {
    fail('harness', `${runnerRel} calls fail/note/ok directly — check logic belongs in a scripts/checks/*.mjs module, not the runner`);
  } else {
    ok();
  }

  const moduleFiles = walk(join(root, 'scripts/checks')).filter((f) => f.endsWith('.mjs'));
  for (const f of moduleFiles) {
    const name = basename(f);
    if (!runnerText.includes(`checks/${name}`)) {
      fail('harness', `scripts/checks/${name} exists but is never imported by ${runnerRel}`);
    } else {
      ok();
    }
  }
}
