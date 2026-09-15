import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { root, walk } from '../lib/files.mjs';

// --- Runner stays thin, every topic module stays wired ----------------------
// guard(#168): a topic module present on disk but never imported by the
// runner runs nothing and reports nothing — exactly the silence layer 1
// exists to catch. Keeps the split honest, mechanically, so it cannot
// silently regress back into one monolith: the runner may only wire modules
// together and call report(), never fail/note/ok directly.
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
