import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';

export default async function ({ fail, ok }: Reporter) {
  // --- No test file under src/ — unit tests live only under tests/unit/. ---
  {
    const files = walk(join(root, 'apps/desktop/src'));
    if (files.length === 0) {
      fail('desktop-tests', 'no files scanned under apps/desktop/src — the guard cannot pass vacuously');
    } else {
      let violated = false;
      for (const f of files) {
        if (f.endsWith('.test.ts') || f.endsWith('.test.tsx') || f.endsWith('.test.mts')) {
          violated = true;
          const rel = relOf(f);
          const underSrc = rel.slice('apps/desktop/src/'.length);
          fail('desktop-tests', `${rel} is a unit test under src/ — move it to apps/desktop/tests/unit/${underSrc}`);
        }
      }
      if (!violated) ok();
    }
  }

  // --- vitest reads tests/unit/ only. ---
  {
    const text = readFileSync(join(root, 'apps/desktop/vitest.config.mts'), 'utf8');
    const includeMatch = /include:\s*\[([\s\S]*?)\]/.exec(text);
    const includeSpan = includeMatch?.[1] ?? '';
    if (/'src\//.test(includeSpan)) {
      fail('desktop-tests', "apps/desktop/vitest.config.mts's include array still reads tests from src/");
    } else if (!includeSpan.includes("'tests/unit/**/*.test.ts'")) {
      fail('desktop-tests', "apps/desktop/vitest.config.mts's include array is missing 'tests/unit/**/*.test.ts'");
    } else ok();
  }
}
