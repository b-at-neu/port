import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// The relay loop's own module rails — dependency-free, regex-based, reading directories by
// explicit path, never walk('apps/').
export default async function ({ expect, fail, ok }: Reporter) {
  const sharedRelayDir = 'apps/desktop/src/shared/relay';
  const mainRelayDir = 'apps/desktop/src/main/relay';
  const classifyFile = `${sharedRelayDir}/classify.ts`;
  const readFile = `${mainRelayDir}/read.ts`;
  // The Escalation section (and the two markers it names) moved out of PIPELINE.md into this file.
  const recoveryFile = 'plugins/port/docs/RECOVERY.md';
  const skillFile = 'plugins/port/skills/pipeline/SKILL.md';

  const srcDir = join(root, 'apps/desktop/src');
  const allFiles = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  const sharedRelayFiles = allFiles.filter((f) => relOf(f).startsWith(`${sharedRelayDir}/`));
  const mainRelayFiles = allFiles.filter((f) => relOf(f).startsWith(`${mainRelayDir}/`));

  if (sharedRelayFiles.filter((f) => !relOf(f).endsWith('.test.ts')).length === 0) {
    fail('desktop-relay', `${sharedRelayDir} has no source files — the guard cannot pass vacuously if the directory is deleted`);
    return;
  }
  if (mainRelayFiles.filter((f) => !relOf(f).endsWith('.test.ts')).length === 0) {
    fail('desktop-relay', `${mainRelayDir} has no source files — the guard cannot pass vacuously if the directory is deleted`);
    return;
  }

  // --- (1) shared/relay/ imports no node: builtin and nothing from main/, keeping the pure
  // classifier/composer layer's typecheck:web compatibility. ---
  {
    let impure = false;
    for (const f of sharedRelayFiles) {
      if (relOf(f).endsWith('.test.ts')) continue;
      const text = readFileSync(f, 'utf8');
      if (/from\s+'node:/.test(text) || /from\s+'.*\/main\//.test(text) || /from\s+'\.\.\/\.\.\/main\//.test(text)) {
        impure = true;
        fail('desktop-relay', `${relOf(f)} imports a node: builtin or a main/ path — shared/relay/ must compile under typecheck:web`);
      }
    }
    if (!impure) ok();
  }

  // --- (2) main/relay/read.ts calls no gh(/ghJson(/runCommand( — it only reads transcripts already on disk, never calls out. ---
  {
    const text = readFileSync(join(root, readFile), 'utf8');
    expect(!/\b(gh|ghJson|runCommand)\(/.test(text), 'desktop-relay', `${readFile} calls gh(/ghJson(/runCommand( — it must only read local transcripts`);
  }

  // pin: `shared/relay/classify.ts`'s `RELAY_MARKERS` ↔ the inline-code ALL-CAPS markers in `docs/RECOVERY.md`'s own "## Escalation" section, both directions
  {
    const classifyText = readFileSync(join(root, classifyFile), 'utf8');
    const markerValues = [...classifyText.matchAll(/(?:questions|blocked):\s*'([^']+)'/g)].map((m) => m[1]);

    const recoveryText = readFileSync(join(root, recoveryFile), 'utf8');
    const escapeStart = recoveryText.indexOf('## Escalation');
    const nextHeading = recoveryText.indexOf('\n## ', escapeStart + 1);
    const escalationSection = escapeStart === -1 ? '' : recoveryText.slice(escapeStart, nextHeading === -1 ? undefined : nextHeading);

    const docTokens = [...escalationSection.matchAll(/`([A-Z][A-Z ]{2,}:)`/g)].map((m) => m[1]);
    const docSet = new Set(docTokens);
    const markerSet = new Set(markerValues);

    if (escapeStart === -1) {
      fail('desktop-relay', `${recoveryFile} has no '## Escalation' heading — the marker pin cannot resolve a section to compare against`);
    } else if (docSet.size < 2) {
      fail('desktop-relay', `${recoveryFile}'s '## Escalation' section carries fewer than two ALL-CAPS inline-code markers — the pin cannot pass vacuously`);
    } else {
      const onlyInClassify = markerValues.filter((m) => !docSet.has(m));
      const onlyInDoc = docTokens.filter((t) => !markerSet.has(t));
      expect(!(onlyInClassify.length > 0 || onlyInDoc.length > 0), 'desktop-relay', `${classifyFile}'s RELAY_MARKERS (${markerValues.join(', ')}) and ${recoveryFile}'s '## Escalation' markers (${docTokens.join(', ')}) disagree`);
    }
  }

  // pin: `shared/relay/classify.ts`'s `USAGE_LIMIT_PHRASE` ↔ `plugins/port/skills/pipeline/SKILL.md`'s own relay-loop prose — one direction only, since the reverse is not extractable from that section's prose
  {
    const classifyText = readFileSync(join(root, classifyFile), 'utf8');
    const phraseMatch = /USAGE_LIMIT_PHRASE\s*=\s*'([^']+)'/.exec(classifyText);
    const skillText = readFileSync(join(root, skillFile), 'utf8');
    if (!phraseMatch) {
      fail('desktop-relay', `${classifyFile} has no 'USAGE_LIMIT_PHRASE = ...' assignment`);
    } else expect(skillText.includes(phraseMatch[1]), 'desktop-relay', `${skillFile} does not name '${phraseMatch[1]}' — the usage-limit class would drift from the cockpit's own prose`);
  }

  // --- (5) running/alive/isLive banned under shared/relay/ and main/relay/ — a local
  // transcript read must never be presented as proof of a live agent. ---
  {
    let violated = false;
    for (const f of [...sharedRelayFiles, ...mainRelayFiles]) {
      const rel = relOf(f);
      const codeOnly = readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      for (const word of ['running', 'alive', 'isLive']) {
        if (new RegExp(`\\b${word}\\b`).test(codeOnly)) {
          violated = true;
          fail('desktop-relay', `${rel} declares '${word}' — a local transcript read is activity, never liveness (ENGINEERING §4)`);
        }
      }
    }
    if (!violated) ok();
  }

  // --- (6) main/relay/read.ts names no timer, classify.ts anchors markers at a line start
  // rather than a bare `includes(` — matched anywhere, a marker would fire on a message that merely quotes the convention. ---
  {
    const readText = readFileSync(join(root, readFile), 'utf8');
    expect(!/\b(setTimeout|setInterval)\(/.test(readText), 'desktop-relay', `${readFile} names a timer — the relay reader must be recomputed only when called, on the sessions source's own cadence`);

    const classifyText = readFileSync(join(root, classifyFile), 'utf8');
    const anchored = /new RegExp\(`\^/.test(classifyText);
    const bareIncludes = /text\.includes\(RELAY_MARKERS/.test(classifyText);
    if (!anchored) {
      fail('desktop-relay', `${classifyFile} has no line-start-anchored ('^') marker pattern — a marker must count only at the start of a line`);
    } else expect(!bareIncludes, 'desktop-relay', `${classifyFile} matches a marker with a bare 'text.includes(RELAY_MARKERS...)' — form, not substring`);
  }
}
