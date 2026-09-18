import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson } from '../lib/files.mjs';

// The four worktree-reclamation blocks split out of scripts/checks/cockpit.mjs
// (issue 181, splitting that module's own file-size ratchet entry) — named to
// mirror scripts/checks/artifacts.mjs, which pins plugins/port/templates/
// artifacts.mjs the same way this pins templates/worktrees.mjs.
export default async function ({ fail, ok }) {
  // --- Worktree reclamation template is self-contained and cross-platform ----
  // guard(#144): the one file an adopting repository copies alone breaking
  // silently outside this checkout, or reaching outside its contract —
  // never shell out via a POSIX-only binary name or a shell string.
  {
    const rel = 'plugins/port/templates/worktrees.mjs';
    const text = readFileSync(join(root, rel), 'utf8');

    const relativeImport = /\bfrom\s+['"]\.\.?\//.exec(text);
    if (relativeImport) {
      fail('worktrees-template', `${rel} has a relative import (${JSON.stringify(relativeImport[0])}) — it must be self-contained`);
    } else {
      ok();
    }

    if (/\bexecSync\b/.test(text)) {
      fail('worktrees-template', `${rel} uses execSync — every child process must use spawnSync with an explicit argv array`);
    } else {
      ok();
    }

    if (/shell:\s*true/.test(text)) {
      fail('worktrees-template', `${rel} passes shell: true to a child process — every call must be an explicit argv array, never a shell string`);
    } else {
      ok();
    }

    // Strip comment-only lines first — the file's own docstring names both
    // forbidden calls as a disclaimer ("Never in this script: `git fetch`,
    // `git worktree add`, …"), which must not itself trip this check.
    const codeOnly = text
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    if (/git\(\[['"]fetch['"]|git\(\[[^\]]*['"]worktree['"],\s*['"]add['"]/.test(codeOnly)) {
      fail('worktrees-template', `${rel} must never run 'git fetch' or 'git worktree add' — those are outside its contract`);
    } else {
      ok();
    }
  }

  // --- Worktree reclamation classifier ----------------------------------------
  // guard(#144): the correlation ladder or the classification precedence
  // silently drifting from what PIPELINE.md documents. Unit-tests the pure
  // functions in isolation from every git/gh call.
  {
    const { parsePorcelain, correlate, classifyCandidate } =
      await import(pathToFileURL(join(root, 'plugins/port/templates/worktrees.mjs')).href);

    // parsePorcelain: main worktree first, a linked one, a locked one with a
    // reason, and a detached one.
    {
      const porcelain = [
        'worktree /repo',
        'HEAD aaaa111',
        'branch refs/heads/dev',
        '',
        'worktree /repo/.claude/worktrees/impl-144',
        'HEAD bbbb222',
        'branch refs/heads/144-worktree-reclaim-install-guard',
        '',
        'worktree /repo/.claude/worktrees/agent-abc',
        'HEAD cccc333',
        'detached',
        'locked reason: agent still running',
        '',
      ].join('\n');
      const records = parsePorcelain(porcelain);
      if (records.length !== 3) {
        fail('worktrees-classifier', `parsePorcelain: expected 3 records, got ${records.length}`);
      } else if (records[0].path !== '/repo' || records[1].branch !== '144-worktree-reclaim-install-guard') {
        fail('worktrees-classifier', `parsePorcelain: unexpected record shape ${JSON.stringify(records)}`);
      } else if (!records[2].locked || records[2].lockReason !== 'reason: agent still running' || !records[2].detached) {
        fail('worktrees-classifier', `parsePorcelain: locked/detached record parsed wrong: ${JSON.stringify(records[2])}`);
      } else {
        ok();
      }
    }

    // correlate: each rung in turn, first hit wins, and #0 is never a
    // correlation.
    {
      const cases = [
        [{ upstreamMergeRef: 'refs/heads/503-fix-thing' }, { number: 503, rung: 'upstream-branch' }],
        [{ branch: '149-foo' }, { number: 149, rung: 'branch-name' }],
        [{ dirBasename: 'impl-77' }, { number: 77, rung: 'directory-basename' }],
        [{ headSubject: '#67 fix the thing' }, { number: 67, rung: 'head-subject' }],
        [{ headSubject: '#0 something' }, null],
        [{ headSubject: 'Merge pull request #157 from x' }, null],
        [{}, null],
        // First hit wins: upstream beats a branch name that would also match.
        [{ upstreamMergeRef: 'refs/heads/12-a', branch: '99-b' }, { number: 12, rung: 'upstream-branch' }],
      ];
      for (const [input, expected] of cases) {
        const got = correlate(input);
        const gotStr = JSON.stringify(got);
        const expStr = JSON.stringify(expected);
        if (gotStr !== expStr) {
          fail('worktrees-classifier', `correlate(${JSON.stringify(input)}): expected ${expStr}, got ${gotStr}`);
        } else {
          ok();
        }
      }
    }

    // classifyCandidate: precedence outside → protect → locked → dirty →
    // active → done/no-work → unresolved.
    {
      const cases = [
        ['outside beats everything', { isOutside: true, isProtected: true, locked: true, dirty: true, itemState: 'OPEN' }, 'outside', false],
        ['protect forces active over a done state', { isProtected: true, itemState: 'MERGED' }, 'active', false],
        ['locked beats a done state — reclaimable once unlocked', { locked: true, itemState: 'CLOSED' }, 'locked', false],
        ['dirty downgrades an otherwise-removable no-work candidate', { dirty: true, itemState: null, isAncestor: true }, 'dirty', false],
        ['dirty is irrelevant to an active candidate', { dirty: true, itemState: 'OPEN' }, 'active', false],
        ['OPEN is active, never removable', { itemState: 'OPEN' }, 'active', false],
        ['CLOSED is done, removable', { itemState: 'CLOSED' }, 'done', true],
        ['MERGED is done, removable', { itemState: 'MERGED' }, 'done', true],
        ['no correlation, HEAD is an ancestor of integration → no-work, removable', { itemState: null, isAncestor: true }, 'no-work', true],
        ['no correlation, HEAD is not an ancestor → unresolved, never removable', { itemState: null, isAncestor: false }, 'unresolved', false],
        ['NOT_FOUND (itemState null with no ancestor fact) → unresolved, never done', { itemState: null, isAncestor: null }, 'unresolved', false],
      ];
      for (const [label, input, expectedState, expectedRemovable] of cases) {
        const full = { isOutside: false, isProtected: false, locked: false, dirty: false, itemState: null, isAncestor: null, ...input };
        const got = classifyCandidate(full);
        if (got.state !== expectedState || got.removable !== expectedRemovable) {
          fail(
            'worktrees-classifier',
            `classifyCandidate — ${label}: expected {state: '${expectedState}', removable: ${expectedRemovable}}, got ${JSON.stringify(got)}`,
          );
        } else {
          ok();
        }
      }
    }
  }

  // --- Cockpit hygiene invokes the worktree script, never bare git worktree --
  // guard(#144): the cockpit's worktree hygiene collapsing back into the
  // prose issue 62 already tried once. The cockpit's hygiene section must
  // call `commands.worktrees` and must not itself run `git worktree remove`.
  {
    const rel = 'plugins/port/skills/pipeline/SKILL.md';
    const text = readFileSync(join(root, rel), 'utf8');

    if (!text.includes('commands.worktrees')) {
      fail('worktree-hygiene', `${rel} never names 'commands.worktrees' — hygiene must be delegated to the script, not reimplemented in prose`);
    } else {
      ok();
    }

    const hygieneStart = text.indexOf('Worktree hygiene');
    if (hygieneStart === -1) {
      fail('worktree-hygiene', `${rel} has no 'Worktree hygiene' section`);
    } else {
      const hygieneEnd = text.indexOf('\n**Denial report', hygieneStart);
      const hygieneSection = hygieneEnd === -1 ? text.slice(hygieneStart) : text.slice(hygieneStart, hygieneEnd);
      if (/git worktree remove --force/.test(hygieneSection)) {
        fail('worktree-hygiene', `${rel}'s hygiene section still invokes 'git worktree remove --force' directly — this must be the script's job now`);
      } else {
        ok();
      }
    }
  }

  // --- Cockpit's config table carries commands.worktrees ----------------------
  // guard(#144): the config key existing in only some of the places that
  // must agree on it — the cockpit would read a placeholder nothing sets.
  {
    const schemaProps = readJson('schema/port.config.schema.json').properties.commands.properties;
    if (!schemaProps.worktrees) {
      fail('worktree-hygiene', "schema/port.config.schema.json's commands object has no 'worktrees' property");
    } else {
      ok();
    }

    const template = readJson('plugins/port/templates/port.config.json');
    if (!('worktrees' in (template.commands ?? {}))) {
      fail('worktree-hygiene', 'plugins/port/templates/port.config.json has no commands.worktrees key');
    } else {
      ok();
    }

    const selfHost = readJson('.claude/port.config.json');
    if (typeof selfHost.commands?.worktrees !== 'string') {
      fail('worktree-hygiene', ".claude/port.config.json's commands.worktrees must be set for this repository's own self-hosting");
    } else {
      ok();
    }
  }
}
