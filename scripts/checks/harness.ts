import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { root, walk } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// --- Runner stays thin, every topic module stays wired ----------------------
// guard(#168): a topic module present on disk but never imported by the
// runner runs nothing and reports nothing — exactly the silence layer 1
// exists to catch. Keeps the split honest, mechanically, so it cannot
// silently regress back into one monolith: the runner may only wire modules
// together and call report(), never fail/note/ok directly.
export default async function ({ fail, ok }: Reporter) {
  const runnerRel = 'scripts/checks.ts';
  const runnerText = readFileSync(join(root, runnerRel), 'utf8');

  if (/\b(?:fail|note|ok)\(/.test(runnerText)) {
    fail('harness', `${runnerRel} calls fail/note/ok directly — check logic belongs in a scripts/checks/*.ts module, not the runner`);
  } else {
    ok();
  }

  const moduleFiles = walk(join(root, 'scripts/checks')).filter((f) => f.endsWith('.ts'));
  // guard(#122): an extension filter that matches nothing runs no assertions
  // and reports nothing — the exact silence layer 1 exists to catch, and
  // exactly what a half-finished rename produces.
  if (moduleFiles.length === 0) {
    fail('harness', `scripts/checks/*.ts matched zero files — the topic-module scan itself is broken`);
  } else {
    ok();
  }
  for (const f of moduleFiles) {
    const name = basename(f);
    if (!runnerText.includes(`checks/${name}`)) {
      fail('harness', `scripts/checks/${name} exists but is never imported by ${runnerRel}`);
    } else {
      ok();
    }
  }

  // --- No file under plugins/port/ carries a .ts extension --------------------
  // guard(#122): type stripping needs Node >=22.18, which an adopting
  // repository never agreed to — a shipped .ts file would pass every check
  // here while failing silently in their checkout. This is the boundary
  // between what this repository strips at load and what it ships.
  const shippedTsFiles = walk(join(root, 'plugins/port')).filter((f) => f.endsWith('.ts'));
  if (shippedTsFiles.length > 0) {
    for (const f of shippedTsFiles) {
      fail('harness-shipped-ts', `plugins/port/ carries a .ts file (${f.slice(join(root, 'plugins/port').length + 1)}) — an adopting repository's Node may not support type stripping`);
    }
  } else {
    ok();
  }
}
