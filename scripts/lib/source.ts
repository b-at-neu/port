// Shared source-text helpers for the checks that read desktop source files.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';

interface SrcFilesOptions {
  tests?: boolean;
  exts?: string[];
}

/** Absolute paths of every source file under the repo-relative `dir`, `*.test.*` files excluded unless `tests` is set. */
export const srcFiles = (dir: string, { tests = false, exts = ['.ts', '.tsx', '.mts'] }: SrcFilesOptions = {}): string[] =>
  walk(join(root, dir)).filter((f) => exts.some((e) => f.endsWith(e)) && (tests || !/\.test\.[^/\\]+$/.test(f)));

/** `text` with block and line comments removed. */
export const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** Fails once per file for which `find(text, rel)` returns a message, and fails when `files` is empty so the scan cannot pass vacuously. */
export function forbid(
  { fail, ok }: Pick<Reporter, 'fail' | 'ok'>,
  check: string,
  files: string[],
  find: (text: string, rel: string) => string | null,
): void {
  if (files.length === 0) {
    fail(check, 'no files were scanned');
    return;
  }
  let clean = true;
  for (const f of files) {
    const rel = relOf(f);
    const message = find(readFileSync(f, 'utf8'), rel);
    if (message !== null) {
      clean = false;
      fail(check, `${rel}: ${message}`);
    }
  }
  if (clean) ok();
}
