import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { root, walk } from '../lib/files.ts';
import { parseModule } from '../lib/guards.ts';
import type { Reporter } from '../lib/report.ts';

// --- Every check module carries at least one well-formed guard marker ------
// guard(#217): a fixed regression left with no mechanical record at all —
// docs/TESTING.md's single hub-file table meant nearly every guard-adding
// pull request touched the same file, so this replaces the table with a
// `guard(#N): <description>` marker colocated on the check block it
// describes. Extracts the block comments and the `//`-prefixed prose from
// `text` — everything a marker's `#N` citation could legitimately come
// from — concatenated so a citation is found regardless of comment style.
function commentText(text: string): string {
  const blocks = [...text.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => m[0]).join('\n');
  const lineComments = text
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? '' : line.slice(idx);
    })
    .join('\n');
  return `${blocks}\n${lineComments}`;
}

/** Every `#N` a module's comments cite, excluding `#0` — the sentinel this
 *  repository uses for "no issue", never a real citation needing a guard. */
function citedIssues(text: string): Set<number> {
  return new Set(
    [...commentText(text).matchAll(/#(\d+)/g)]
      .map((m) => Number(m[1]))
      .filter((n) => n !== 0),
  );
}

/** Validates one module's guard markers against the three rules `guards.ts`
 *  exists to enforce. Returns an array of failure strings — empty means the
 *  module passes. Pure, so the same function checks a real file and an
 *  inline self-test fixture. */
function validateModule(text: string, moduleName: string): string[] {
  const problems: string[] = [];
  const entries = parseModule(text, moduleName);

  if (entries.length === 0) {
    problems.push(`${moduleName}: no guard entries — every check module must declare at least one`);
    return problems;
  }

  for (const e of entries) {
    if (e.issuesRaw !== null && e.issues === null) {
      problems.push(`${moduleName}: guard marker for '${e.title}' has an unparsable issue list (${JSON.stringify(e.issuesRaw)})`);
    }
    if (e.description.length === 0) {
      problems.push(`${moduleName}: guard marker for '${e.title}' has an empty description`);
    }
  }

  const covered = new Set(entries.flatMap((e) => e.issues ?? []));
  for (const issue of citedIssues(text)) {
    if (!covered.has(issue)) {
      problems.push(`${moduleName}: comment cites #${issue}, which no guard(...) marker in this module covers — add or extend a marker, or write "issue ${issue}" if it is not a guard citation`);
    }
  }

  return problems;
}

export default async function ({ fail, ok }: Reporter) {
  // --- Self-test — a check that cannot be made to fail is not a check --------
  // guard(#217): a validator that only ever proves acceptance, never
  // rejection, is worth nothing more than a comment. One clean fixture and
  // three that must each fail their own rule: an issue cited with no
  // marker, a marker with an empty description, and an unparsable issue
  // list.
  {
    // Built via concatenation, never as a literal "//" in this file's own
    // source: a fixture below deliberately mimics a comment citing an issue
    // with no covering marker, and this same check's real scan (below) reads
    // this very file back off disk — a literal, adjacent "//" here would be
    // indistinguishable from a real citation and demand a marker for a
    // number that exists only inside a fixture string.
    const cmt = '/'.repeat(2);

    const clean = [`${cmt} --- A clean check ---`, `${cmt} guard(#1): a real regression this block pins.`, 'export default async function () {}'].join(
      '\n',
    );
    if (validateModule(clean, 'fixture-clean').length !== 0) {
      fail('guards', 'validateModule rejected a well-formed fixture module');
    } else {
      ok();
    }

    const citedWithNoMarker = [
      `${cmt} --- A check ---`,
      `${cmt} Fixes the regression from #2, no marker below.`,
      `${cmt} guard(#1): unrelated.`,
    ].join('\n');
    const citedProblems = validateModule(citedWithNoMarker, 'fixture-cited');
    if (!citedProblems.some((p) => p.includes('#2'))) {
      fail('guards', 'validateModule accepted a module citing #2 in prose with no guard(#2) marker');
    } else {
      ok();
    }

    const emptyDescription = [`${cmt} --- A check ---`, `${cmt} guard(#1):`].join('\n');
    if (!validateModule(emptyDescription, 'fixture-empty').some((p) => p.includes('empty description'))) {
      fail('guards', 'validateModule accepted a guard marker with an empty description');
    } else {
      ok();
    }

    const badIssueList = [`${cmt} --- A check ---`, `${cmt} guard(#abc): a description.`].join('\n');
    if (!validateModule(badIssueList, 'fixture-bad-issue').some((p) => p.includes('unparsable'))) {
      fail('guards', 'validateModule accepted guard(#abc), a non-numeric issue reference');
    } else {
      ok();
    }
  }

  // --- The real scan — every scripts/checks/*.ts module ---------------------
  // guard(#217): a module with no guard marker passing vacuously, or a
  // regression fixed in one module and only ever recorded in prose the way
  // docs/TESTING.md's table used to be, with nothing checking it survived.
  {
    const files = walk(join(root, 'scripts/checks')).filter((f) => f.endsWith('.ts'));
    for (const f of files) {
      const moduleName = basename(f, '.ts');
      const text = readFileSync(f, 'utf8');
      const problems = validateModule(text, moduleName);
      if (problems.length === 0) {
        ok();
      } else {
        for (const p of problems) fail('guards', p);
      }
    }
  }
}
