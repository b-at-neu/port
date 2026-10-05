import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { root, walk } from '../lib/files.ts';
import { parseModule } from '../lib/guards.ts';
import type { Reporter } from '../lib/report.ts';

/** Validates one module's guard/pin markers against the rules `guards.ts`
 *  exists to enforce. Returns an array of failure strings — empty means the
 *  module passes. Pure, so the same function checks a real file and an
 *  inline self-test fixture. */
function validateModule(text: string, moduleName: string): { problems: string[]; pinCount: number } {
  const problems: string[] = [];
  const entries = parseModule(text, moduleName);
  const pinEntries = entries.filter((e) => e.kind === 'pin');

  for (const e of entries) {
    if (e.issuesRaw !== null && e.issues === null) {
      problems.push(`${moduleName}: guard marker for '${e.title}' has an unparsable issue list (${JSON.stringify(e.issuesRaw)})`);
    }
    if (e.description.length === 0) {
      problems.push(`${moduleName}: ${e.kind} marker for '${e.title}' has an empty description`);
    }
    if (e.kind === 'pin') {
      // A pin is a standing structural rule, never a fix record.
      if (e.issuesRaw !== null) {
        problems.push(`${moduleName}: pin marker for '${e.title}' declares an issue list (${JSON.stringify(e.issuesRaw)}) — a pin is a standing structural rule and declares no issues`);
      }
      if (e.description.length > 0 && !e.description.includes('↔')) {
        problems.push(`${moduleName}: pin marker for '${e.title}' description ${JSON.stringify(e.description)} does not name two things with '↔' — a pin names two things or it is not a pin`);
      }
    }
  }

  return { problems, pinCount: pinEntries.length };
}

export default async function ({ fail, ok }: Reporter) {
  // --- Self-test — a check that cannot be made to fail is not a check --------
  // One clean fixture, plus one that must fail for each rule below: an empty
  // description and an unparsable issue list.
  {
    // Built via concatenation, never a literal "//" — this file is itself
    // scanned by the comment ratchet, which would otherwise count a fixture
    // citation as a real one.
    const cmt = '/'.repeat(2);

    const clean = [`${cmt} --- A clean check ---`, `${cmt} guard(#1): a real regression this block pins.`, 'export default async function () {}'].join(
      '\n',
    );
    if (validateModule(clean, 'fixture-clean').problems.length !== 0) {
      fail('guards', 'validateModule rejected a well-formed fixture module');
    } else {
      ok();
    }

    const emptyDescription = [`${cmt} --- A check ---`, `${cmt} guard(#1):`].join('\n');
    if (!validateModule(emptyDescription, 'fixture-empty').problems.some((p) => p.includes('empty description'))) {
      fail('guards', 'validateModule accepted a guard marker with an empty description');
    } else {
      ok();
    }

    const badIssueList = [`${cmt} --- A check ---`, `${cmt} guard(#abc): a description.`].join('\n');
    if (!validateModule(badIssueList, 'fixture-bad-issue').problems.some((p) => p.includes('unparsable'))) {
      fail('guards', 'validateModule accepted guard(#abc), a non-numeric issue reference');
    } else {
      ok();
    }

    // --- pin: well-formed, an issue list, and a missing '↔' ------------------
    // guard(#255): a pin marker declaring an issue list (a pin is a standing
    // structural rule, never a fix record), or naming only one thing instead
    // of two — the exact shape every real §2 row avoided.
    const wellFormedPin = [`${cmt} --- A pinned check ---`, `${cmt} guard(#1): a real regression this block pins.`, `${cmt} pin: \`a\` ↔ \`b\``].join('\n');
    if (validateModule(wellFormedPin, 'fixture-pin-clean').problems.length !== 0) {
      fail('guards', 'validateModule rejected a well-formed pin fixture');
    } else {
      ok();
    }

    const pinWithIssues = [`${cmt} --- A check ---`, `${cmt} guard(#1): a real regression this block pins.`, `${cmt} pin(#2): \`a\` ↔ \`b\``].join('\n');
    if (!validateModule(pinWithIssues, 'fixture-pin-issues').problems.some((p) => p.includes('declares an issue list'))) {
      fail('guards', 'validateModule accepted a pin(#2) marker — a pin declares no issue list');
    } else {
      ok();
    }

    const pinNoArrow = [`${cmt} --- A check ---`, `${cmt} guard(#1): a real regression this block pins.`, `${cmt} pin: names only one thing`].join('\n');
    if (!validateModule(pinNoArrow, 'fixture-pin-no-arrow').problems.some((p) => p.includes("does not name two things with '↔'"))) {
      fail('guards', 'validateModule accepted a pin marker with no ↔ — a pin names two things or it is not a pin');
    } else {
      ok();
    }
  }

  // --- The real scan — every scripts/checks/*.ts module ---------------------
  // Validates every existing guard/pin marker's shape, and counts the real
  // `pin:` markers found — a zero count below is a failure, never a silent
  // zero.
  let totalPins = 0;
  {
    const files = walk(join(root, 'scripts/checks')).filter((f) => f.endsWith('.ts'));
    for (const f of files) {
      const moduleName = basename(f, '.ts');
      const text = readFileSync(f, 'utf8');
      const { problems, pinCount } = validateModule(text, moduleName);
      totalPins += pinCount;
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
