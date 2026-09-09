import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson } from '../lib/files.mjs';

export default async function ({ fail, ok }) {
  // --- Artifact validator template is self-contained --------------------------
  // An adopting repository copies plugins/port/templates/artifacts.mjs alone —
  // no plugins/port/, no scripts/lib/ — so a relative import that resolves here
  // and nowhere else would break silently for every adopter while passing in
  // this repository.
  {
    const rel = 'plugins/port/templates/artifacts.mjs';
    const text = readFileSync(join(root, rel), 'utf8');
    const relativeImport = /\bfrom\s+['"]\.\.?\//.exec(text);
    if (relativeImport) {
      fail('artifacts-template', `${rel} has a relative import (${JSON.stringify(relativeImport[0])}) — it must be self-contained`);
    } else {
      ok();
    }
  }

  // --- Artifact validator's LABELS table matches labels.json ------------------
  // The template can't import labels.json (previous check), so it carries its
  // own copy. The two must agree on keys, names, and modules, both directions,
  // or `audit`'s label resolution silently drifts from the source of truth.
  {
    const { LABELS } = await import(pathToFileURL(join(root, 'plugins/port/templates/artifacts.mjs')).href);
    const canonical = new Map(readJson('plugins/port/templates/labels.json').labels.map((l) => [l.key, l]));
    for (const [key, entry] of Object.entries(LABELS)) {
      const c = canonical.get(key);
      if (!c) {
        fail('artifacts-labels', `artifacts.mjs's LABELS has key '${key}', which is not in labels.json`);
      } else if (c.name !== entry.name || c.module !== entry.module) {
        fail(
          'artifacts-labels',
          `artifacts.mjs's LABELS.${key} is ${JSON.stringify(entry)}, but labels.json says ${JSON.stringify({ name: c.name, module: c.module })}`,
        );
      }
    }
    for (const key of canonical.keys()) {
      if (!(key in LABELS)) fail('artifacts-labels', `labels.json has key '${key}', missing from artifacts.mjs's LABELS`);
    }
    ok();
  }

  // --- Artifact registry claims every heading constant, both directions -------
  // A seventh `*_HEADING` export with no matching `CHECKS` entry is validated
  // by `audit` alone and unreachable from `check` — exactly #204's bug. A
  // registry `heading` that isn't `===` one of the module's own exports is a
  // retyped literal that would silently stop tracking the real constant.
  {
    const mod = await import(pathToFileURL(join(root, 'plugins/port/templates/artifacts.mjs')).href);
    const headingExports = Object.keys(mod).filter((k) => /_HEADING$/.test(k));
    const registryHeadings = Object.values(mod.CHECKS).map((e) => e.heading).filter((h) => h != null);
    for (const name of headingExports) {
      if (!registryHeadings.includes(mod[name])) {
        fail('artifacts-registry', `${name} is exported but claimed by no CHECKS entry`);
      } else {
        ok();
      }
    }
    for (const [kind, entry] of Object.entries(mod.CHECKS)) {
      if (entry.heading != null && !headingExports.some((name) => mod[name] === entry.heading)) {
        fail('artifacts-registry', `CHECKS.${kind}'s heading is not one of artifacts.mjs's own *_HEADING exports`);
      } else {
        ok();
      }
      if (typeof entry.run !== 'function') {
        fail('artifacts-registry', `CHECKS.${kind}.run is not a function — an entry cannot be half-wired`);
      } else {
        ok();
      }
    }
  }

  // --- Artifact validator's patterns accept a good example, reject a bad one --
  // A check that cannot be made to fail is not a check. The commit case uses the
  // real historical failure: a 378-character paragraph with no '#N ' prefix,
  // standing in for the explanatory-text subject that recurred four times in one
  // pipeline run before this validator existed.
  {
    const { COMMIT_SUBJECT, REVIEW_HEADING, REVISION_HEADING, REVISION_OPENS, REVISION_DETAIL, OPERATOR_ONLY_STEP, CHECKS } =
      await import(pathToFileURL(join(root, 'plugins/port/templates/artifacts.mjs')).href);

    const cases = [
      [
        'COMMIT_SUBJECT',
        COMMIT_SUBJECT,
        '#149 fix the thing',
        'The first commit on this branch has a malformed subject line: instead of the required format, its subject is an entire paragraph of explanatory text describing everything that changed across every file touched by this pull request in exhaustive detail',
      ],
      ['REVIEW_HEADING', REVIEW_HEADING, '## Code Review — Cycle 1 · approved', '## Code Audit — Cycle 1 · approved'],
      ['REVISION_HEADING', REVISION_HEADING, '## Revision — Cycle 1', '## Revision (Cycle 1)'],
      ['OPERATOR_ONLY_STEP', OPERATOR_ONLY_STEP, '- [ ] **operator-only** click the button', '- [ ] click the button'],
    ];
    for (const [name, re, good, bad] of cases) {
      if (!re.test(good)) fail('artifacts-patterns', `${name} rejects its own good example ${JSON.stringify(good)}`);
      else if (re.test(bad)) fail('artifacts-patterns', `${name} accepts its bad example ${JSON.stringify(bad)}`);
      else ok();
    }

    const goodDetail = 'fixed R1-C1 · abc1234';
    const badDetail = 'Fixed the critical issue in the commit abc1234';
    if (!(REVISION_OPENS.test(goodDetail) && REVISION_DETAIL.test(goodDetail))) {
      fail('artifacts-patterns', `REVISION_DETAIL rejects its own good example ${JSON.stringify(goodDetail)}`);
    } else if (REVISION_OPENS.test(badDetail) && REVISION_DETAIL.test(badDetail)) {
      fail('artifacts-patterns', `REVISION_DETAIL accepts its bad example ${JSON.stringify(badDetail)}`);
    } else {
      ok();
    }

    // withdrawn / rebase-required return { ok } from a closure, not a regex,
    // so they're exercised against PIPELINE.md's canonical bodies (good), the
    // same body with only the SHA backticked (bad: names no fact), and the
    // same body under a renamed heading (bad: wrong line 1) (#204).
    const shaCases = [
      [
        'withdrawn',
        '## Approval withdrawn\n`ci/build` went **FAILURE** on `abc1234def` after approval. https://example.com/1',
        '## Approval withdrawn\nWent **FAILURE** on `abc1234def` after approval.',
        '## Approval revoked\n`ci/build` went **FAILURE** on `abc1234def` after approval.',
      ],
      [
        'rebase-required',
        '## Rebase required\nConflicts with `main` at `abc1234def` — GitHub can\'t build a merge ref, so no checks ran on this diff.',
        '## Rebase required\nConflicts with a branch at `abc1234def` — GitHub can\'t build a merge ref.',
        '## Rebase pending\nConflicts with `main` at `abc1234def` — GitHub can\'t build a merge ref.',
      ],
    ];
    for (const [kind, good, badFact, badHeading] of shaCases) {
      const run = CHECKS[kind].run;
      if (!run(good).ok) fail('artifacts-patterns', `${kind} rejects its own good example`);
      else if (run(badFact).ok) fail('artifacts-patterns', `${kind} accepts a body naming only a SHA`);
      else if (run(badHeading).ok) fail('artifacts-patterns', `${kind} accepts a renamed heading`);
      else ok();
    }
  }
}
