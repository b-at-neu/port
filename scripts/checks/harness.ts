import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// --- Runner stays thin, every topic module stays wired: the runner discovers every
// scripts/checks/*.ts file from disk and imports each dynamically, never hand-listing one. ---
export default async function ({ expect, fail, ok }: Reporter) {
  const runnerRel = 'scripts/checks.ts';
  const runnerText = readFileSync(join(root, runnerRel), 'utf8');

  expect(!/\b(?:fail|note|ok)\(/.test(runnerText), 'harness', `${runnerRel} calls fail/note/ok directly — check logic belongs in a scripts/checks/*.ts module, not the runner`);

  // A static `import … from './checks/…'` line reappearing is the half-wired shape to guard against.
  expect(!/from\s+['"]\.\/checks\//.test(runnerText), 'harness', `${runnerRel} carries a static 'import … from ./checks/…' line — every topic module must be discovered from disk, never hand-listed`);

  const moduleFiles = walk(join(root, 'scripts/checks')).filter((f) => f.endsWith('.ts'));
  // An extension filter matching nothing runs no assertions and reports nothing — silent.
  expect(!(moduleFiles.length === 0), 'harness', `scripts/checks/*.ts matched zero files — the topic-module scan itself is broken`);

  // --- No file under plugins/port/ carries a .ts extension — type stripping needs a Node
  // floor an adopting repository never agreed to; a shipped .ts file fails silently in their checkout. ---
  const shippedTsFiles = walk(join(root, 'plugins/port')).filter((f) => f.endsWith('.ts'));
  if (shippedTsFiles.length > 0) {
    for (const f of shippedTsFiles) {
      fail('harness-shipped-ts', `plugins/port/ carries a .ts file (${f.slice(join(root, 'plugins/port').length + 1)}) — an adopting repository's Node may not support type stripping`);
    }
  } else {
    ok();
  }
}
