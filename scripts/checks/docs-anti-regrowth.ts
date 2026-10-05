import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

const NAMES_CHECKS_FILE = /scripts\/checks\/[\w-]+\.ts/;
const HAS_PIN_ROW = /^\|.*↔.*\|.*\|\s*$/m;

export default async function ({ expect }: Reporter) {
  // --- (a) docs/TESTING.md's Layer 1 section names no file under scripts/checks/ ---
  // guard: the regression #255 fixed — a "Guards for X, in
  // scripts/checks/Y.ts:" prose block restating marker descriptions already
  // colocated, regrowing the hub issue 217 tried to retire. The section may
  // still name the directory itself, just never a file under it.
  {
    const fixtureRegrown = 'Guards for X, in `scripts/checks/labels.ts`:\n\n- some restated marker description.';
    expect(NAMES_CHECKS_FILE.test(fixtureRegrown), 'docs-anti-regrowth', 'did not flag a synthetic Layer 1 section naming scripts/checks/labels.ts');

    const testingText = readFileSync(join(root, 'docs/TESTING.md'), 'utf8');
    const layerOneMatch = /## Layer 1 — static checks([\s\S]*?)(?:\n## |$)/.exec(testingText);
    expect(layerOneMatch, 'docs-anti-regrowth', 'docs/TESTING.md has no "## Layer 1 — static checks" section to scan');
    if (layerOneMatch) {
      expect(
        !NAMES_CHECKS_FILE.test(layerOneMatch[1]),
        'docs-anti-regrowth',
        'docs/TESTING.md\'s Layer 1 section names a file under scripts/checks/ — the hub #217/#255 retired has regrown',
      );
    }
  }

  // --- (b) docs/ENGINEERING.md carries no table row with '↔' ---
  // guard: §2's 30-row copy-pin table growing back — every row in that
  // table joined its two copies with '↔', so a fresh row is the tell.
  {
    const fixtureRow = '| `a` ↔ `b` | "some check" |';
    expect(HAS_PIN_ROW.test(fixtureRow), 'docs-anti-regrowth', 'did not flag a synthetic table row containing ↔');

    const engineeringText = readFileSync(join(root, 'docs/ENGINEERING.md'), 'utf8');
    expect(
      !HAS_PIN_ROW.test(engineeringText),
      'docs-anti-regrowth',
      'docs/ENGINEERING.md carries a table row containing ↔ — §2\'s copy-pin table has regrown; pins are declared on the check that enforces each, never gathered into a table',
    );
  }
}
