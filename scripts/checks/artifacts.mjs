import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson } from '../lib/files.mjs';

export default async function ({ fail, ok }) {
  // --- Artifact validator's LABELS table matches labels.json ------------------
  // guard(#149): audit's label resolution drifting from the source of truth
  // now that it can't import the file directly. The template can't import
  // labels.json (previous check), so it carries its own copy. The two must
  // agree on keys, names, and modules, both directions.
  {
    const { LABELS } = await import(pathToFileURL(join(root, 'plugins/port/bin/artifacts.mjs')).href);
    const canonical = new Map(readJson('plugins/port/data/labels.json').labels.map((l) => [l.key, l]));
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
  // guard(#204): a seventh artifact kind reachable from audit but not from
  // check, one artifact claimed under two kind names, or a registry heading
  // retyped as a diverging literal — an identically retyped one still
  // compares equal for the two string-typed headings. A seventh `*_HEADING`
  // export with no matching `CHECKS` entry is validated by `audit` alone and
  // unreachable from `check`. Two entries sharing one heading is that bug
  // mirrored: one artifact would carry two kind names, and `audit`'s registry
  // loop would `fold` twice on the same comment — so the pin is *exactly* one
  // claim, never merely at least one. The reverse direction catches a
  // registry `heading` retyped as a *diverging* literal: `===` on the two
  // string-typed headings compares by value, so an identically retyped
  // literal passes, and identity only bites for the regex-typed `review` /
  // `revision` entries.
  {
    const mod = await import(pathToFileURL(join(root, 'plugins/port/bin/artifacts.mjs')).href);
    const headingExports = Object.keys(mod).filter((k) => /_HEADING$/.test(k));
    const registryHeadings = Object.values(mod.CHECKS).map((e) => e.heading).filter((h) => h != null);
    for (const name of headingExports) {
      const claimed = registryHeadings.filter((h) => h === mod[name]);
      if (claimed.length === 0) {
        fail('artifacts-registry', `${name} is exported but claimed by no CHECKS entry`);
      } else if (claimed.length > 1) {
        fail(
          'artifacts-registry',
          `${name} is claimed by ${claimed.length} CHECKS entries — one artifact must have exactly one kind name`,
        );
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
  // guard(#149): a pattern that cannot be made to fail is not a pattern. The
  // commit case uses the real historical failure: a 378-character paragraph
  // with no '#N ' prefix, standing in for the explanatory-text subject that
  // recurred four times in one pipeline run before this validator existed.
  {
    const { COMMIT_SUBJECT, REVIEW_HEADING, REVISION_HEADING, REVISION_OPENS, REVISION_DETAIL, OPERATOR_ONLY_STEP, CHECKS } =
      await import(pathToFileURL(join(root, 'plugins/port/bin/artifacts.mjs')).href);

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

  // --- stageViolation: pair-wise pull-request stage legality -------------------
  // guard(#231): the layer 2 audit's stage rule only ever counted
  // PR_STAGE_KEYS, never the refresh pair, so issue 225's `ready for review`
  // + `refresh branch` state passed silently. Legal: at most one stage label,
  // beside at most one refresh label — the refresh pair is the sanctioned
  // co-presence (PIPELINE.md → "Branch refresh"). Both directions asserted,
  // and a failing case's message must name the labels actually offending,
  // not just a count.
  {
    const { stageViolation } = await import(pathToFileURL(join(root, 'plugins/port/bin/artifacts.mjs')).href);
    const legal = [
      [['ready for review'], ['refresh branch']],
      [['approved'], ['refreshing']],
      [['approved'], []],
      [[], []],
    ];
    for (const [stages, refresh] of legal) {
      if (stageViolation(stages, refresh) != null) {
        fail('artifacts-stage-legality', `stageViolation(${JSON.stringify(stages)}, ${JSON.stringify(refresh)}) reported a violation for a legal state`);
      } else {
        ok();
      }
    }
    const violating = [
      { stages: ['ready for review', 'needs human'], refresh: ['refresh branch'], offending: ['ready for review', 'needs human'] },
      { stages: ['approved'], refresh: ['refresh branch', 'refreshing'], offending: ['refresh branch', 'refreshing'] },
    ];
    for (const { stages, refresh, offending } of violating) {
      const msg = stageViolation(stages, refresh);
      if (msg == null) {
        fail('artifacts-stage-legality', `stageViolation(${JSON.stringify(stages)}, ${JSON.stringify(refresh)}) reported no violation for an illegal state`);
      } else if (!offending.every((name) => msg.includes(name))) {
        fail('artifacts-stage-legality', `stageViolation's message ${JSON.stringify(msg)} does not name every offending label in ${JSON.stringify(offending)}`);
      } else {
        ok();
      }
    }
  }

  // --- Artifact workflow's trigger widened, narrowing moved to the step -------
  // guard(#231): the layer 2 audit running only at `approved`, so a malformed
  // commit subject or pull request body survived a full plan → implement →
  // review cycle before anything objected (issue 222). Read off
  // plugins/port/templates/artifacts.yml only — "Workflow copies stay
  // rendered from their templates" already pins the live copy to it. Three
  // rails: the widened trigger and the retired literal are what keep this
  // reachable as a required check; the indentation arm is what keeps the job
  // itself from being skippable, which is the one shape that can leave a
  // required check unreported.
  {
    const rel = 'plugins/port/templates/artifacts.yml';
    const text = readFileSync(join(root, rel), 'utf8');

    const typesLine = /^\s*types:\s*\[([^\]]*)\]/m.exec(text);
    const types = typesLine ? typesLine[1].split(',').map((t) => t.trim()) : [];
    for (const t of ['labeled', 'opened', 'synchronize']) {
      if (!types.includes(t)) fail('artifacts-trigger', `${rel}'s pull_request 'types:' is missing '${t}'`);
      else ok();
    }

    const ifLines = [...text.matchAll(/^( *)if:/gm)];
    // `runs-on:` is a job-level field guaranteed to sit at job-attribute
    // indentation — the threshold `if:` must sit deeper than, since a step's
    // fields nest one level inside the `steps:` list beyond that.
    const jobAttrIndent = /^( *)runs-on:/m.exec(text)?.[1]?.length;
    if (ifLines.length !== 1 || jobAttrIndent == null) {
      fail('artifacts-trigger', `${rel} must carry exactly one 'if:' key and a 'runs-on:' job field`);
    } else if (ifLines[0][1].length <= jobAttrIndent) {
      fail('artifacts-trigger', `${rel}'s 'if:' sits at job indentation — it must be a step condition, or a 'labeled' event with no matching label leaves the whole job, and any required check on it, unreported`);
    } else {
      ok();
    }

    const retired = 'NEVER register this as a required status check';
    for (const p of [rel, 'docs/TESTING.md']) {
      if (readFileSync(join(root, p), 'utf8').includes(retired)) {
        fail('artifacts-trigger', `${p} still carries the retired '${retired}' warning`);
      } else {
        ok();
      }
    }
  }
}
