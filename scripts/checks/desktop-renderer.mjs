import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '../lib/files.mjs';

// #83: apps/desktop/src/renderer/ never builds a node from a string it does
// not fully control — a tool result or a diff line is untrusted text from
// the network and from repositories. One assertion pins the absence of every
// HTML-injection sink, in the shape of desktop-platform.mjs's own
// shell/fs-primitive guards: broken deliberately once (a real `innerHTML`
// assignment) before being trusted to pass.
const FORBIDDEN = [
  { pattern: /\.innerHTML\s*=/, label: '.innerHTML =' },
  { pattern: /\.outerHTML\s*=/, label: '.outerHTML =' },
  { pattern: /\.insertAdjacentHTML\s*\(/, label: '.insertAdjacentHTML(' },
  { pattern: /document\.write\s*\(/, label: 'document.write(' },
  { pattern: /\beval\s*\(/, label: 'eval(' },
  { pattern: /new\s+Function\s*\(/, label: 'new Function(' },
];

export default async function ({ fail, ok }) {
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
}
