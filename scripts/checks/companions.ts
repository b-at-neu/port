import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { root, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// The mechanical guard against drift in the runner-plus-companions shape SKILL.md/PIPELINE.md
// use — a split prose hub whose companion nobody reads is the documentation analogue of the unimported check module harness.ts already guards.
export default async function ({ expect, fail, ok }: Reporter) {
  // --- A split companion stays reachable from its hub, never an unnamed, unreachable document. ---
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
        expect(hubText.includes(companion), 'companions', `${relOf(join(dir, companion))} exists but is never named by ${relOf(hub)} — a reader following the hub never learns it exists`);
      }
    }

    const docsDir = join(root, 'plugins/port/docs');
    const docsHub = join(docsDir, 'PIPELINE.md');
    const docsHubText = readFileSync(docsHub, 'utf8');
    const docsCompanions = readdirSync(docsDir).filter((f) => f.endsWith('.md') && f !== 'PIPELINE.md');
    for (const companion of docsCompanions) {
      expect(docsHubText.includes(companion), 'companions', `${relOf(join(docsDir, companion))} exists but is never named by ${relOf(docsHub)} — a reader following the hub never learns it exists`);
    }
  }

  // --- Companion unions are directory-derived, never a hard-coded list — editing on every future split would reintroduce the phrase-check churn this check retires. ---
  {
    const rel = 'scripts/lib/files.ts';
    const text = readFileSync(join(root, rel), 'utf8');
    const codeOnly = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');

    for (const fn of ['pipelineSkillText', 'pipelineDocsText']) {
      expect(codeOnly.includes(fn), 'companions', `${rel} no longer exports '${fn}'`);
    }

    expect(/readdirSync/.test(codeOnly), 'companions', `${rel}'s companion-union helper no longer lists a directory with readdirSync — it must derive its file list from disk, not a hard-coded array`);

    expect(!/['"][A-Za-z][A-Za-z-]*\.md['"]/.test(codeOnly), 'companions', `${rel} hard-codes a companion filename in code — the union must be derived from the directory listing, not a literal list`);
  }
}
