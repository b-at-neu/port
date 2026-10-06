import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// --- No HTML-injection sink in the renderer: a tool result or diff line is untrusted text,
// so apps/desktop/src/renderer/ never builds a node from a string it does not fully control. ---
const FORBIDDEN = [
  { pattern: /\.innerHTML\s*=/, label: '.innerHTML =' },
  { pattern: /\.outerHTML\s*=/, label: '.outerHTML =' },
  { pattern: /\.insertAdjacentHTML\s*\(/, label: '.insertAdjacentHTML(' },
  { pattern: /document\.write\s*\(/, label: 'document.write(' },
  { pattern: /\beval\s*\(/, label: 'eval(' },
  { pattern: /new\s+Function\s*\(/, label: 'new Function(' },
  { pattern: /dangerouslySetInnerHTML/, label: 'dangerouslySetInnerHTML' },
];

export default async function ({ expect, fail, ok }: Reporter) {
  const dir = 'apps/desktop/src/renderer';
  const files = walk(join(root, dir)).filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts'));

  if (files.length === 0) {
    fail('desktop-renderer', `${dir} has no source files — the guard cannot pass vacuously if the directory is deleted`);
    return;
  }
  ok();

  let violated = false;
  for (const f of files) {
    const rel = relOf(f);
    const text = readFileSync(f, 'utf8');
    for (const { pattern, label } of FORBIDDEN) {
      if (pattern.test(text)) {
        violated = true;
        fail('desktop-renderer', `${rel} contains '${label}' — untrusted transcript and repository text must only ever reach the DOM via createElement/textContent`);
      }
    }
  }
  if (!violated) ok();

  // --- The TranscriptEntry row builder is declared only in entry-rows.ts — scoped to this
  // exact signature, never a bare `buildRow` (board/rows.ts declares its own, unrelated one). ---
  {
    const signature = /function buildRow\(entry:\s*TranscriptEntry\)/;
    const declarations = files.filter((f) => signature.test(readFileSync(f, 'utf8')));
    const declaredElsewhere = declarations.filter((f) => relOf(f) !== 'apps/desktop/src/renderer/src/entry-rows.ts');
    if (declarations.length === 0) {
      fail('desktop-renderer', 'no file under apps/desktop/src/renderer/ declares function buildRow(entry: TranscriptEntry) — entry-rows.ts should');
    } else expect(!(declaredElsewhere.length > 0), 'desktop-renderer', `function buildRow(entry: TranscriptEntry) is declared outside entry-rows.ts, in: ${declaredElsewhere.map(relOf).join(', ')}`);
  }
}
