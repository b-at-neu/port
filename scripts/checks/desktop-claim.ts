import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// The claim dialog's five mechanical rails — dependency-free, regex-based, reading
// directories by explicit path, never walk('apps/').
export default async function ({ expect, fail, ok }: Reporter) {
  const githubDir = 'apps/desktop/src/main/github';
  const queryFile = `${githubDir}/query.ts`;
  const adapterFile = `${githubDir}/adapter.ts`;
  const classifyFile = 'apps/desktop/src/shared/claim/classify.ts';
  const skillFile = 'plugins/port/skills/pipeline/SKILL.md';

  const srcDir = join(root, 'apps/desktop/src');
  const allFiles = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));

  if (allFiles.length === 0) {
    fail('desktop-claim', 'apps/desktop/src has no source files — the guard cannot pass vacuously if the directory is deleted');
    return;
  }

  // --- 'blockedBy(' — a GraphQL field selection, never a second query builder. adapter.ts's
  // `raw.blockedBy` read does not match this pattern, since it is a reader, not a builder. ---
  {
    let found = false;
    let sawQueryFile = false;
    for (const f of allFiles) {
      const rel = relOf(f);
      if (rel.endsWith('.test.ts')) continue; // asserting against the built document is not a second query builder
      const text = readFileSync(f, 'utf8');
      if (!text.includes('blockedBy(')) continue;
      if (rel === queryFile) {
        sawQueryFile = true;
      } else {
        found = true;
        fail('desktop-claim', `${rel} contains 'blockedBy(' — only ${queryFile} may select it from GraphQL`);
      }
    }
    if (!sawQueryFile) fail('desktop-claim', `${queryFile} does not contain 'blockedBy(' — the guard cannot pass vacuously`);
    else if (!found) ok();
  }

  // --- 'viewer {' and 'viewerLogin' stay inside main/github/ — the renderer never asserts
  // who is signed in, only displays what main resolved. ---
  {
    let found = false;
    let sawSelection = false;
    let sawResolution = false;
    for (const f of allFiles) {
      const rel = relOf(f);
      const text = readFileSync(f, 'utf8');
      const hasSelection = text.includes('viewer {');
      const hasResolution = text.includes('viewerLogin');
      if (!hasSelection && !hasResolution) continue;
      if (rel.startsWith(`${githubDir}/`)) {
        if (hasSelection) sawSelection = true;
        if (hasResolution) sawResolution = true;
      } else {
        found = true;
        fail('desktop-claim', `${rel} contains a viewer-identity pattern — only files under ${githubDir} may select or resolve the signed-in login`);
      }
    }
    if (!sawSelection) fail('desktop-claim', `no file under ${githubDir} contains 'viewer {' — the guard cannot pass vacuously`);
    else if (!sawResolution) fail('desktop-claim', `no file under ${githubDir} contains 'viewerLogin' — the guard cannot pass vacuously`);
    else if (!found) ok();
  }

  // --- No file under apps/desktop/src/ contains the literal '@me' — the login must be resolved and recorded, never an unattributable sentinel. ---
  {
    let found = false;
    for (const f of allFiles) {
      const text = readFileSync(f, 'utf8');
      if (text.includes("'@me'") || text.includes('"@me"')) {
        found = true;
        fail('desktop-claim', `${relOf(f)} contains the literal '@me' — the login must be resolved and recorded, never a sentinel`);
      }
    }
    if (!found) ok();
  }

  // --- buildClaimRequest's expect.absent names 'marker' — the two-stage-label guard against claiming an already in-pipeline issue. ---
  {
    const text = readFileSync(join(root, classifyFile), 'utf8');
    expect(/absent:\s*\['marker'\]/.test(text), 'desktop-claim', `${classifyFile} does not set 'absent: ['marker']' — the two-stage-label guard must not be quietly dropped`);
  }

  // pin: `shared/claim/classify.ts`'s opt-in key set (`CLAIM_LABEL_KEYS` + `AUTO_PLAN_KEY`) ↔ `plugins/port/skills/pipeline/SKILL.md`'s "work on #N" paragraph's `<labels.X>` keys, both directions
  {
    const text = readFileSync(join(root, classifyFile), 'utf8');
    const claimKeysMatch = /CLAIM_LABEL_KEYS[^=]*=\s*\[([^\]]*)\]/.exec(text);
    const autoPlanMatch = /AUTO_PLAN_KEY[^=]*=\s*'([^']+)'/.exec(text);
    const skillText = readFileSync(join(root, skillFile), 'utf8');
    const paragraphMatch = /\*\*"work on #N"\*\*[\s\S]*?(?=\n- \*\*)/.exec(skillText);

    if (!claimKeysMatch) {
      fail('desktop-claim', `${classifyFile} has no 'CLAIM_LABEL_KEYS = [...]' array`);
    } else if (!autoPlanMatch) {
      fail('desktop-claim', `${classifyFile} has no 'AUTO_PLAN_KEY = ...' assignment`);
    } else if (!paragraphMatch) {
      fail('desktop-claim', `${skillFile} has no "work on #N" opt-in paragraph to compare against`);
    } else {
      const appKeys = [...claimKeysMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).concat(autoPlanMatch[1]).sort();
      const paragraphKeys = [...new Set([...paragraphMatch[0].matchAll(/<labels\.([a-zA-Z]+)>/g)].map((m) => m[1]))].sort();
      const appSet = new Set(appKeys);
      const paragraphSet = new Set(paragraphKeys);
      const onlyInApp = appKeys.filter((k) => !paragraphSet.has(k));
      const onlyInParagraph = paragraphKeys.filter((k) => !appSet.has(k));
      expect(!(onlyInApp.length > 0 || onlyInParagraph.length > 0), 'desktop-claim', `${classifyFile}'s opt-in key set (${JSON.stringify(appKeys)}) and ${skillFile}'s "work on #N" paragraph (${JSON.stringify(paragraphKeys)}) disagree`);
    }
  }
}
