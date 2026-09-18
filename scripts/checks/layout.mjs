import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { root, relOf } from '../lib/files.mjs';

// One-contract-per-directory rail for the three-way split under
// plugins/port/ (#171): templates/ keeps only fill-in templates, bin/ keeps
// only self-contained executables, data/ keeps only canonical JSON, and no
// tracked file still names one of the four moved paths under its old
// templates/-relative location. docs/ENGINEERING.md §1 states the split;
// this is what pins it so the next executable or data file cannot land in
// templates/ silently the way worktrees.mjs and budget.mjs both did before
// this ticket.
export default async function ({ fail, note, ok }) {
  // --- templates/ holds only fill-in templates, both directions ---------------
  // guard(#171): a new executable or canonical-data file landing in
  // templates/ the way worktrees.mjs and budget.mjs both did after issue 149
  // established the precedent — a manifest forces a decision about a new
  // file's role instead of silently accepting it.
  {
    const dir = 'plugins/port/templates';
    const expected = new Set([
      'ENGINEERING.template.md',
      'DESIGN.template.md',
      'AUDITOR.template.md',
      'SCAFFOLDER.template.md',
      'permissions.base.json',
      'port.config.json',
      'approval-check.yml',
      'artifacts.yml',
    ]);
    const actual = new Set(readdirSync(join(root, dir)).filter((f) => statSync(join(root, dir, f)).isFile()));
    for (const f of actual) {
      if (!expected.has(f)) {
        fail(
          'layout-templates',
          `${dir}/${f} is not in this check's fill-in-template manifest — move it to plugins/port/bin/ (an executable) or plugins/port/data/ (canonical data), or extend the manifest if it genuinely is a fill-in template`,
        );
      } else {
        ok();
      }
    }
    for (const f of expected) {
      if (!actual.has(f)) {
        fail('layout-templates', `${dir}/${f} is in this check's manifest but does not exist on disk`);
      } else {
        ok();
      }
    }
  }

  // --- bin/ holds only self-contained .mjs -------------------------------------
  // guard(#171): the precedent issue 149 established per file — an adopting
  // repository copies each of these alone, so none may carry a relative
  // import — now enforced directory-wide, so a fourth script added here is
  // covered automatically rather than needing its own per-file check block.
  {
    const dir = 'plugins/port/bin';
    for (const f of readdirSync(join(root, dir))) {
      const abs = join(root, dir, f);
      if (!statSync(abs).isFile()) {
        fail('layout-bin', `${dir}/${f} is not a file — bin/ holds only self-contained executables`);
        continue;
      }
      if (!f.endsWith('.mjs')) {
        fail('layout-bin', `${dir}/${f} is not a .mjs file — bin/ holds only self-contained executables`);
        continue;
      }
      const text = readFileSync(abs, 'utf8');
      const relativeImport = /\bfrom\s+['"]\.\.?\//.exec(text);
      if (relativeImport) {
        fail(
          'layout-bin',
          `${dir}/${f} has a relative import (${JSON.stringify(relativeImport[0])}) — every file an adopter copies alone must be self-contained`,
        );
      } else {
        ok();
      }
    }
  }

  // --- data/ holds only canonical JSON -----------------------------------------
  // guard(#171): data/ exists to name the canonical-data role; a non-JSON
  // file there would blur it back into looking like a second templates/.
  {
    const dir = 'plugins/port/data';
    for (const f of readdirSync(join(root, dir))) {
      if (!f.endsWith('.json')) {
        fail('layout-data', `${dir}/${f} is not JSON — data/ holds only canonical data`);
      } else {
        ok();
      }
    }
  }

  // --- No stale path survives the move -----------------------------------------
  // guard(#171): a reference to one of the four moved files' old
  // templates/-relative location surviving somewhere `docs.mjs`'s own
  // "Stale references" scan does not reach — that check is markdown-only and
  // scoped to four trees, while these paths live in .mjs, .json, .yml, and
  // .ts too. Excludes only this file itself, which names the four strings by
  // construction; docs/TESTING.md's description of this very rule is worded
  // to avoid forming the literal substrings for the same reason.
  {
    const banned = ['templates/artifacts.mjs', 'templates/worktrees.mjs', 'templates/budget.mjs', 'templates/labels.json'];
    const selfRel = 'scripts/checks/layout.mjs';
    let files = null;
    try {
      files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
        .split('\0')
        .filter(Boolean);
    } catch (e) {
      note(`layout: 'git ls-files' unavailable (${e.message}) — skipping the stale-path scan`);
    }
    if (files) {
      let scanned = 0;
      for (const f of files) {
        if (f === selfRel || f === 'pnpm-lock.yaml') continue;
        const abs = join(root, f);
        if (!existsSync(abs) || !statSync(abs).isFile()) continue;
        const text = readFileSync(abs, 'utf8');
        scanned++;
        for (const b of banned) {
          if (text.includes(b)) {
            fail('layout-stale-path', `${relOf(abs)}: still names '${b}', which moved to plugins/port/bin/ or plugins/port/data/ (#171)`);
          }
        }
      }
      note(`layout: ${scanned} tracked files scanned for stale templates/-relative paths`);
      ok();
    }
  }
}
