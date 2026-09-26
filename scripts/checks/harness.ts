import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// --- Runner stays thin, every topic module stays wired ----------------------
// guard(#255): a topic module present on disk but never run — issue 168's
// original regression — is now structurally impossible, since the runner
// carries no static per-module import to omit one from: it discovers every
// scripts/checks/*.ts file from disk and imports each dynamically. What
// replaces issue 168's guard is the rail that makes it impossible in the
// first place — the runner may never hand-list a module, only wire
// whatever the scan finds together and call report(), never fail/note/ok
// directly.
export default async function ({ fail, ok }: Reporter) {
  const runnerRel = 'scripts/checks.ts';
  const runnerText = readFileSync(join(root, runnerRel), 'utf8');

  if (/\b(?:fail|note|ok)\(/.test(runnerText)) {
    fail('harness', `${runnerRel} calls fail/note/ok directly — check logic belongs in a scripts/checks/*.ts module, not the runner`);
  } else {
    ok();
  }

  // guard(#255): a static `import … from './checks/…'` line reappearing is
  // the exact half-wired shape issue 168 originally guarded against — the
  // runner must discover every topic module from disk, never hand-list
  // one, or a module added to the list but never actually present on disk
  // (or vice versa) can silently drift again.
  if (/from\s+['"]\.\/checks\//.test(runnerText)) {
    fail('harness', `${runnerRel} carries a static 'import … from ./checks/…' line — every topic module must be discovered from disk, never hand-listed`);
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
