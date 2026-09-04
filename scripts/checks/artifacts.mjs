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

  // --- Artifact validator's patterns accept a good example, reject a bad one --
  // A check that cannot be made to fail is not a check. The commit case uses the
  // real historical failure: a 378-character paragraph with no '#N ' prefix,
  // standing in for the explanatory-text subject that recurred four times in one
  // pipeline run before this validator existed.
  {
    const { COMMIT_SUBJECT, REVIEW_HEADING, REVISION_HEADING, REVISION_OPENS, REVISION_DETAIL, OPERATOR_ONLY_STEP } =
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
  }
}
