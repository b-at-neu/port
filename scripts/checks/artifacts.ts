import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

export default async function ({ expect, fail, ok }: Reporter) {
  // --- Artifact validator's LABELS table matches labels.json ------------------
  // guard(#149): audit's label resolution drifting from the source of truth
  // now that it can't import the file directly. The template can't import
  // labels.json (previous check), so it carries its own copy. The two must
  // agree on keys, names, and modules, both directions.
  // pin: `bin/artifacts.mjs`'s `LABELS` ↔ `labels.json`
  {
    const { LABELS }: { LABELS: Record<string, any> } = await import(pathToFileURL(join(root, 'plugins/port/bin/artifacts.mjs')).href);
    const canonical = new Map<string, any>(readJson('plugins/port/data/labels.json').labels.map((l: any) => [l.key, l]));
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
    const mod: any = await import(pathToFileURL(join(root, 'plugins/port/bin/artifacts.mjs')).href);
    const headingExports = Object.keys(mod).filter((k) => /_HEADING$/.test(k));
    const registryHeadings = Object.values<any>(mod.CHECKS).map((e) => e.heading).filter((h) => h != null);
    for (const name of headingExports) {
      const claimed = registryHeadings.filter((h) => h === mod[name]);
      if (claimed.length === 0) {
        fail('artifacts-registry', `${name} is exported but claimed by no CHECKS entry`);
      } else expect(!(claimed.length > 1), 'artifacts-registry', `${name} is claimed by ${claimed.length} CHECKS entries — one artifact must have exactly one kind name`);
    }
    for (const [kind, entry] of Object.entries<any>(mod.CHECKS)) {
      expect(!(entry.heading != null && !headingExports.some((name) => mod[name] === entry.heading)), 'artifacts-registry', `CHECKS.${kind}'s heading is not one of artifacts.mjs's own *_HEADING exports`);
      expect(!(typeof entry.run !== 'function'), 'artifacts-registry', `CHECKS.${kind}.run is not a function — an entry cannot be half-wired`);
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
      else expect(!re.test(bad), 'artifacts-patterns', `${name} accepts its bad example ${JSON.stringify(bad)}`);
    }

    const goodDetail = 'fixed R1-C1 · abc1234';
    const badDetail = 'Fixed the critical issue in the commit abc1234';
    if (!(REVISION_OPENS.test(goodDetail) && REVISION_DETAIL.test(goodDetail))) {
      fail('artifacts-patterns', `REVISION_DETAIL rejects its own good example ${JSON.stringify(goodDetail)}`);
    } else expect(!(REVISION_OPENS.test(badDetail) && REVISION_DETAIL.test(badDetail)), 'artifacts-patterns', `REVISION_DETAIL accepts its bad example ${JSON.stringify(badDetail)}`);

    // withdrawn / rebase-required return { ok } from a closure, not a regex,
    // so they're exercised against FORMATS.md's canonical bodies (good), the
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
      else expect(!run(badHeading).ok, 'artifacts-patterns', `${kind} accepts a renamed heading`);
    }

    // guard(#288): the revise #N route's own artifact — a 'changes-requested'
    // body with no SHA, a renamed heading, or only the heading and SHA with
    // no actual request text — passing the validator silently. It has no
    // backtick-quoted fact beside the SHA (the request itself is free text),
    // so it is exercised against its own closure cases rather than folded
    // into shaCases above: one good body, plus three bad ones.
    {
      const good = '## Changes requested\nRequested by the operator on `abc1234` after approval:\n\nRename the --limit flag to --max.';
      const headingAndShaOnly = '## Changes requested\n`abc1234`';
      const renamedHeading = '## Changes needed\nRequested by the operator on `abc1234` after approval:\n\nRename the --limit flag to --max.';
      const noSha = '## Changes requested\nRequested by the operator, after approval:\n\nRename the --limit flag to --max.';
      const run = CHECKS['changes-requested'].run;
      if (!run(good).ok) fail('artifacts-patterns', 'changes-requested rejects its own good example');
      else if (run(headingAndShaOnly).ok) fail('artifacts-patterns', 'changes-requested accepts a body with only the heading and SHA, no request text');
      else if (run(renamedHeading).ok) fail('artifacts-patterns', 'changes-requested accepts a renamed heading');
      else expect(!run(noSha).ok, 'artifacts-patterns', 'changes-requested accepts a body with no SHA');
    }

    // pin: `CHANGES_REQUESTED_HEADING` ↔ its literal rendering in
    // revise-agent.md, review-agent.md, SKILL.md, and FORMATS.md.
    {
      const { CHANGES_REQUESTED_HEADING } = await import(pathToFileURL(join(root, 'plugins/port/bin/artifacts.mjs')).href);
      for (const rel of [
        'plugins/port/agents/revise-agent.md',
        'plugins/port/agents/review-agent.md',
        'plugins/port/skills/pipeline/SKILL.md',
        'plugins/port/docs/FORMATS.md',
      ]) {
        expect(readFileSync(join(root, rel), 'utf8').includes(CHANGES_REQUESTED_HEADING), 'artifacts-patterns', `${rel} never names the literal '${CHANGES_REQUESTED_HEADING}'`);
      }
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
      expect(!(stageViolation(stages, refresh) != null), 'artifacts-stage-legality', `stageViolation(${JSON.stringify(stages)}, ${JSON.stringify(refresh)}) reported a violation for a legal state`);
    }
    const violating = [
      { stages: ['ready for review', 'needs human'], refresh: ['refresh branch'], offending: ['ready for review', 'needs human'] },
      { stages: ['approved'], refresh: ['refresh branch', 'refreshing'], offending: ['refresh branch', 'refreshing'] },
    ];
    for (const { stages, refresh, offending } of violating) {
      const msg = stageViolation(stages, refresh);
      if (msg == null) {
        fail('artifacts-stage-legality', `stageViolation(${JSON.stringify(stages)}, ${JSON.stringify(refresh)}) reported no violation for an illegal state`);
      } else expect(offending.every((name) => msg.includes(name)), 'artifacts-stage-legality', `stageViolation's message ${JSON.stringify(msg)} does not name every offending label in ${JSON.stringify(offending)}`);
    }
  }

  // --- Issue-side stage keys pinned to labels.json's roles/surfaces, both
  // directions, plus the issue-side stageViolation cases (#220) ---------------
  // guard(#220): `ISSUE_STAGE_KEYS` drifting from the label vocabulary's own
  // roles/surfaces — a key silently added to one side but not the other
  // leaves the issue-side audit checking the wrong set, exactly the gap
  // issue 209's Route 2 (`plan approved` + `pr opened`) found with nothing
  // pinning the issue surface the way `PR_STAGE_KEYS` already pins the pull
  // request one.
  // pin: `artifacts.mjs`'s `ISSUE_STAGE_KEYS` ↔ `data/labels.json`'s non-marker `issue`-surface keys, both directions
  // pin: `artifacts.mjs`'s `PR_STAGE_KEYS` ∪ `PR_REFRESH_KEYS` ↔ `data/labels.json`'s non-marker `pr`-surface keys, both directions
  {
    const { ISSUE_STAGE_KEYS, PR_STAGE_KEYS, PR_REFRESH_KEYS, stageViolation } =
      await import(pathToFileURL(join(root, 'plugins/port/bin/artifacts.mjs')).href);
    const { LABEL_ROLES, LABEL_SURFACE } = await import(pathToFileURL(join(root, 'scripts/port-tick/config.ts')).href);

    const issueKeys = new Set(
      Object.keys(LABEL_ROLES).filter((k) => LABEL_ROLES[k] !== 'marker' && LABEL_SURFACE[k] === 'issue'),
    );
    for (const key of ISSUE_STAGE_KEYS) {
      expect(issueKeys.has(key), 'artifacts-stage-keys', `artifacts.mjs's ISSUE_STAGE_KEYS names '${key}', which labels.json does not mark as a non-marker issue-surface key`);
    }
    for (const key of issueKeys) {
      expect(ISSUE_STAGE_KEYS.includes(key), 'artifacts-stage-keys', `labels.json marks '${key}' as a non-marker issue-surface key, which artifacts.mjs's ISSUE_STAGE_KEYS omits`);
    }

    const prKeys = new Set(
      Object.keys(LABEL_ROLES).filter((k) => LABEL_ROLES[k] !== 'marker' && LABEL_SURFACE[k] === 'pr'),
    );
    const prUnion = new Set([...PR_STAGE_KEYS, ...PR_REFRESH_KEYS]);
    for (const key of prUnion) {
      expect(prKeys.has(key), 'artifacts-stage-keys', `artifacts.mjs's PR_STAGE_KEYS/PR_REFRESH_KEYS names '${key}', which labels.json does not mark as a non-marker pr-surface key`);
    }
    for (const key of prKeys) {
      expect(prUnion.has(key), 'artifacts-stage-keys', `labels.json marks '${key}' as a non-marker pr-surface key, which artifacts.mjs's PR_STAGE_KEYS/PR_REFRESH_KEYS omits`);
    }

    const issueLabel = (key: string) => readJson('plugins/port/data/labels.json').labels.find((l: any) => l.key === key)?.name;
    const flagged = stageViolation([issueLabel('planApproved'), issueLabel('prOpened')], []);
    expect(!(flagged == null || !flagged.includes(issueLabel('planApproved')) || !flagged.includes(issueLabel('prOpened'))), 'artifacts-stage-keys', `stageViolation(['plan approved', 'pr opened'], []) must name both offending labels — got ${JSON.stringify(flagged)}`);
    const legal = stageViolation([issueLabel('prOpened')], []);
    expect(!(legal != null), 'artifacts-stage-keys', `stageViolation(['pr opened'], []) reported a violation for a legal single issue-stage label`);
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
      expect(types.includes(t), 'artifacts-trigger', `${rel}'s pull_request 'types:' is missing '${t}'`);
    }

    const ifLines = [...text.matchAll(/^( *)if:/gm)];
    // `runs-on:` is a job-level field guaranteed to sit at job-attribute
    // indentation — the threshold `if:` must sit deeper than, since a step's
    // fields nest one level inside the `steps:` list beyond that.
    const jobAttrIndent = /^( *)runs-on:/m.exec(text)?.[1]?.length;
    if (ifLines.length !== 1 || jobAttrIndent == null) {
      fail('artifacts-trigger', `${rel} must carry exactly one 'if:' key and a 'runs-on:' job field`);
    } else expect(!(ifLines[0][1].length <= jobAttrIndent), 'artifacts-trigger', `${rel}'s 'if:' sits at job indentation — it must be a step condition, or a 'labeled' event with no matching label leaves the whole job, and any required check on it, unreported`);

    const retired = 'NEVER register this as a required status check';
    for (const p of [rel, 'docs/TESTING.md']) {
      expect(!readFileSync(join(root, p), 'utf8').includes(retired), 'artifacts-trigger', `${p} still carries the retired '${retired}' warning`);
    }
  }
}
