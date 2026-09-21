import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { root, relOf } from '../lib/files.mjs';

// The mechanical guard against future drift in the runner-plus-companions
// shape #181 gives SKILL.md/PIPELINE.md — a split prose hub whose companion
// nobody reads is the documentation analogue of the unimported check module
// scripts/checks/harness.mjs already guards.
export default async function ({ fail, ok }) {
  // --- A split companion stays reachable from its hub -------------------------
  // guard(#181): a companion document nobody reads. It runs nothing and
  // reports nothing, and a reader following the hub never learns it exists.
  {
    const skillsRoot = join(root, 'plugins/port/skills');
    const skillDirs = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(skillsRoot, e.name));

    for (const dir of skillDirs) {
      const hub = join(dir, 'SKILL.md');
      if (!existsSync(hub)) continue; // every skill directory carries one; defensive only
      const hubText = readFileSync(hub, 'utf8');
      const companions = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'SKILL.md');
      for (const companion of companions) {
        if (!hubText.includes(companion)) {
          fail(
            'companions',
            `${relOf(join(dir, companion))} exists but is never named by ${relOf(hub)} — a reader following the hub never learns it exists`,
          );
        } else {
          ok();
        }
      }
    }

    const docsDir = join(root, 'plugins/port/docs');
    const docsHub = join(docsDir, 'PIPELINE.md');
    const docsHubText = readFileSync(docsHub, 'utf8');
    const docsCompanions = readdirSync(docsDir).filter((f) => f.endsWith('.md') && f !== 'PIPELINE.md');
    for (const companion of docsCompanions) {
      if (!docsHubText.includes(companion)) {
        fail(
          'companions',
          `${relOf(join(docsDir, companion))} exists but is never named by ${relOf(docsHub)} — a reader following the hub never learns it exists`,
        );
      } else {
        ok();
      }
    }
  }

  // --- Companion unions are directory-derived, never a hard-coded list -------
  // guard(#181): the next split of a hub's companions reintroducing exactly
  // the phrase-check churn this ticket retires — a hard-coded file list in
  // pipelineSkillText/pipelineDocsText would need editing on every future
  // split, the same way every union caller once had to when the file list
  // lived only in each caller's own head.
  {
    const rel = 'scripts/lib/files.mjs';
    const text = readFileSync(join(root, rel), 'utf8');
    const codeOnly = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');

    for (const fn of ['pipelineSkillText', 'pipelineDocsText']) {
      if (!codeOnly.includes(fn)) {
        fail('companions', `${rel} no longer exports '${fn}'`);
      } else {
        ok();
      }
    }

    if (!/readdirSync/.test(codeOnly)) {
      fail(
        'companions',
        `${rel}'s companion-union helper no longer lists a directory with readdirSync — it must derive its file list from disk, not a hard-coded array`,
      );
    } else {
      ok();
    }

    if (/['"][A-Za-z][A-Za-z-]*\.md['"]/.test(codeOnly)) {
      fail(
        'companions',
        `${rel} hard-codes a companion filename in code — the union must be derived from the directory listing, not a literal list`,
      );
    } else {
      ok();
    }
  }
}
