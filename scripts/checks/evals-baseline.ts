import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { root, walk, relOf, sectionText } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

/** Every backtick-quoted case name in a table's first column, in source
 *  order — used against both "## The cases" and "## Baseline", which share
 *  this exact row shape (`| \`name\` | ... |`). */
function tableCaseNames(section: string): string[] {
  return [...section.matchAll(/^\|\s*`([a-z0-9-]+)`\s*\|/gm)].map((m) => m[1]);
}

const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;
const NOT_MEASURED = 'not measured — early access';

export default async function ({ fail, ok }: Reporter) {
  const readmeText = readFileSync(join(root, 'evals/README.md'), 'utf8');
  const caseDirs = new Set(
    walk(join(root, 'evals'))
      .filter((f) => basename(f) === 'case.yaml')
      .map((f) => basename(dirname(f))),
  );

  // --- "The cases" and "## Baseline" each cover exactly the case directories,
  // --- both directions ---------------------------------------------------------
  // guard(#124): a case added with no README row (or a stale row for a
  // deleted case) is exactly the drift issue 181's directory-derived unions
  // exist to prevent elsewhere — checked here for these two flat tables
  // directly, since neither is a companion-doc union.
  {
    const casesSection = sectionText(readmeText, 'The cases');
    const baselineSection = sectionText(readmeText, 'Baseline');

    for (const [label, tableText] of [
      ['The cases', casesSection],
      ['Baseline', baselineSection],
    ] as const) {
      const named = new Set(tableCaseNames(tableText));
      for (const dir of caseDirs) {
        if (!named.has(dir)) {
          fail('evals-baseline-coverage', `evals/README.md's "## ${label}" table has no row for evals/${dir}/`);
        }
      }
      for (const name of named) {
        if (!caseDirs.has(name)) {
          fail('evals-baseline-coverage', `evals/README.md's "## ${label}" table names '${name}', which is not a real evals/ case directory`);
        }
      }
      ok();
    }
  }

  // --- Baseline cell grammar, including the delta arithmetic for numeric rows -
  // guard(#124): a malformed or internally inconsistent baseline cell would be
  // read as a real measurement by issue 125 — the one document this epic
  // exists to produce evidence for — so the grammar is enforced the moment
  // any row is filled in, not only once early access lands.
  {
    const baselineSection = sectionText(readmeText, 'Baseline');
    const rows = [...baselineSection.matchAll(/^\|(.+)\|\s*$/gm)]
      .map((m) => m[1].split('|').map((c) => c.trim()))
      .filter((cells) => cells.length === 5 && cells[0] !== 'Case' && !/^-+$/.test(cells[0]));

    for (const [caseCell, , withCell, withoutCell, deltaCell] of rows) {
      const name = caseCell.replace(/`/g, '');

      const withMeasured = withCell !== NOT_MEASURED;
      const withoutMeasured = withoutCell !== NOT_MEASURED;
      const deltaMeasured = deltaCell !== NOT_MEASURED;

      if (withCell !== NOT_MEASURED && !(NUMBER_RE.test(withCell) && Number(withCell) >= 0 && Number(withCell) <= 1)) {
        fail('evals-baseline-grammar', `${name}: With cell '${withCell}' is neither '${NOT_MEASURED}' nor a number in [0, 1]`);
      }
      if (withoutCell !== NOT_MEASURED && !(NUMBER_RE.test(withoutCell) && Number(withoutCell) >= 0 && Number(withoutCell) <= 1)) {
        fail('evals-baseline-grammar', `${name}: Without cell '${withoutCell}' is neither '${NOT_MEASURED}' nor a number in [0, 1]`);
      }
      if (deltaCell !== NOT_MEASURED && !NUMBER_RE.test(deltaCell)) {
        fail('evals-baseline-grammar', `${name}: Delta cell '${deltaCell}' is neither '${NOT_MEASURED}' nor a signed number`);
      }

      if ([withMeasured, withoutMeasured, deltaMeasured].some(Boolean) && ![withMeasured, withoutMeasured, deltaMeasured].every(Boolean)) {
        fail('evals-baseline-grammar', `${name}: mixed row — some cells measured, some '${NOT_MEASURED}'`);
      } else if (withMeasured && withoutMeasured && deltaMeasured) {
        const expected = Math.round((Number(withCell) - Number(withoutCell)) * 100) / 100;
        if (Math.abs(expected - Number(deltaCell)) > 1e-9) {
          fail('evals-baseline-grammar', `${name}: Delta ${deltaCell} does not equal With − Without (${expected})`);
        }
      }
      ok();
    }
  }
}
