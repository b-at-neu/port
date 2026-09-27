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

/** Validates one module's guard/pin markers against the rules `guards.ts`
 *  exists to enforce. Returns an array of failure strings — empty means the
 *  module passes. Pure, so the same function checks a real file and an
 *  inline self-test fixture. */
function validateModule(text: string, moduleName: string): string[] {
  const problems: string[] = [];
  const entries = parseModule(text, moduleName);
  const guardEntries = entries.filter((e) => e.kind === 'guard');
  const pinEntries = entries.filter((e) => e.kind === 'pin');

  if (guardEntries.length === 0) {
    problems.push(`${moduleName}: no guard entries — every check module must declare at least one`);
    if (pinEntries.length === 0) return problems;
  }

  for (const e of entries) {
    if (e.issuesRaw !== null && e.issues === null) {
      problems.push(`${moduleName}: guard marker for '${e.title}' has an unparsable issue list (${JSON.stringify(e.issuesRaw)})`);
    }
    if (e.description.length === 0) {
      problems.push(`${moduleName}: ${e.kind} marker for '${e.title}' has an empty description`);
    }
    if (e.kind === 'pin') {
      // A pin declares no issue list — it is a standing structural rule, not
      // a fix record, and #255's own migration writes "issue N" in prose
      // rather than "#N" for exactly this reason (guards.ts's completeness
      // rule below would otherwise demand a covering guard(#N)).
      if (e.issuesRaw !== null) {
        problems.push(`${moduleName}: pin marker for '${e.title}' declares an issue list (${JSON.stringify(e.issuesRaw)}) — a pin is a standing structural rule and declares no issues`);
      }
      if (e.description.length > 0 && !e.description.includes('↔')) {
        problems.push(`${moduleName}: pin marker for '${e.title}' description ${JSON.stringify(e.description)} does not name two things with '↔' — a pin names two things or it is not a pin`);
      }
    }
  }

  const covered = new Set(guardEntries.flatMap((e) => e.issues ?? []));
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

    // --- pin: well-formed, an issue list, and a missing '↔' ------------------
    // guard(#255): a pin marker declaring an issue list (a pin is a standing
    // structural rule, never a fix record), or naming only one thing instead
    // of two — the exact shape every real §2 row avoided.
    const wellFormedPin = [`${cmt} --- A pinned check ---`, `${cmt} guard(#1): a real regression this block pins.`, `${cmt} pin: \`a\` ↔ \`b\``].join('\n');
    if (validateModule(wellFormedPin, 'fixture-pin-clean').length !== 0) {
      fail('guards', 'validateModule rejected a well-formed pin fixture');
    } else {
      ok();
    }

    const pinWithIssues = [`${cmt} --- A check ---`, `${cmt} guard(#1): a real regression this block pins.`, `${cmt} pin(#2): \`a\` ↔ \`b\``].join('\n');
    if (!validateModule(pinWithIssues, 'fixture-pin-issues').some((p) => p.includes('declares an issue list'))) {
      fail('guards', 'validateModule accepted a pin(#2) marker — a pin declares no issue list');
    } else {
      ok();
    }

    const pinNoArrow = [`${cmt} --- A check ---`, `${cmt} guard(#1): a real regression this block pins.`, `${cmt} pin: names only one thing`].join('\n');
    if (!validateModule(pinNoArrow, 'fixture-pin-no-arrow').some((p) => p.includes("does not name two things with '↔'"))) {
      fail('guards', 'validateModule accepted a pin marker with no ↔ — a pin names two things or it is not a pin');
    } else {
      ok();
    }
  }

  // --- The real scan — every scripts/checks/*.ts module ---------------------
  // guard(#217): a module with no guard marker passing vacuously, or a
  // regression fixed in one module and only ever recorded in prose the way
  // docs/TESTING.md's table used to be, with nothing checking it survived.
  // pin(#255)-completeness: the scan also counts every real `pin:` marker
  // it finds — a vacuous pass after a botched §2 migration is the exact
  // silence layer 1 exists to catch, so zero pins found across the whole
  // scan is a failure below, never a silent zero.
  let totalPins = 0;
  {
    const files = walk(join(root, 'scripts/checks')).filter((f) => f.endsWith('.ts'));
    for (const f of files) {
      const moduleName = basename(f, '.ts');
      const text = readFileSync(f, 'utf8');
      const problems = validateModule(text, moduleName);
      totalPins += parseModule(text, moduleName).filter((e) => e.kind === 'pin').length;
      if (problems.length === 0) {
        ok();
      } else {
        for (const p of problems) fail('guards', p);
      }
    }
  }

  // --- Every pin entry is well-formed, and the migration actually happened ---
  // guard(#255): a botched §2 migration leaving zero real `pin:` markers
  // anywhere, passing vacuously the same way a module with no guard marker
  // used to.
  if (totalPins === 0) {
    fail('guards', 'zero pin(...) markers found across scripts/checks/*.ts — docs/ENGINEERING.md §2 migration produced none');
  } else {
    ok();
  }

  // --- Anti-regrowth (a): docs/TESTING.md's Layer 1 section names no file ---
  // under scripts/checks/
  // guard(#255): the exact regression this ticket fixes — issue 231, issue
  // 171, issue 122, issue 191, issue 106, and issue 206 each appended a
  // "Guards for X, in scripts/checks/Y.ts:" prose block restating marker
  // descriptions already colocated, regrowing the hub issue 217 tried to
  // retire. The section may still name the directory itself (the
  // --guards/--pins command block), just never a file under it. Fails
  // toward the recoverable direction: a false positive costs one reworded
  // sentence, a false negative lets the hub regrow unseen.
  {
    const namesChecksFile = (section: string): boolean => /scripts\/checks\/[\w-]+\.ts/.test(section);

    // Self-test first — an inline fixture mimicking the exact regrown shape.
    const fixtureRegrown = 'Guards for X, in `scripts/checks/labels.ts`:\n\n- some restated marker description.';
    if (!namesChecksFile(fixtureRegrown)) {
      fail('guards', 'namesChecksFile did not flag a synthetic Layer 1 section naming scripts/checks/labels.ts');
    } else {
      ok();
    }

    const testingText = readFileSync(join(root, 'docs/TESTING.md'), 'utf8');
    const layerOneMatch = /## Layer 1 — static checks([\s\S]*?)(?:\n## |$)/.exec(testingText);
    if (!layerOneMatch) {
      fail('guards', 'docs/TESTING.md has no "## Layer 1 — static checks" section to scan');
    } else if (namesChecksFile(layerOneMatch[1])) {
      fail('guards', 'docs/TESTING.md\'s Layer 1 section names a file under scripts/checks/ — the hub #217/#255 retired has regrown');
    } else {
      ok();
    }
  }

  // --- Anti-regrowth (b): docs/ENGINEERING.md carries no table row with '↔' -
  // guard(#255): §2's 30-row copy-pin table growing back after this ticket
  // deletes it — every row in that table joined its two copies with '↔', so
  // a fresh row is the unmistakable tell.
  {
    const hasPinRow = (text: string): boolean => /^\|.*↔.*\|.*\|\s*$/m.test(text);

    const fixtureRow = '| `a` ↔ `b` | "some check" |';
    if (!hasPinRow(fixtureRow)) {
      fail('guards', 'hasPinRow did not flag a synthetic table row containing ↔');
    } else {
      ok();
    }

    const engineeringText = readFileSync(join(root, 'docs/ENGINEERING.md'), 'utf8');
    if (hasPinRow(engineeringText)) {
      fail('guards', 'docs/ENGINEERING.md carries a table row containing ↔ — §2\'s copy-pin table has regrown; pins are declared on the check that enforces each, never gathered into a table');
    } else {
      ok();
    }
  }
}
