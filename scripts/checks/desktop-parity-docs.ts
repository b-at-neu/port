import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipelineDocsText, pipelineSkillText, root } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';

const RELEASE_EXPECTED = ['Release v<version>', 'bump/v<version>', 'bump version to v<version>', '- Minor enhancements and bug fixes'];

// Pins the desktop's copies of plugin docs, skills and agents to their originals.
export default async function ({ expect, fail, ok }: Reporter) {
  // --- The comment bodies agree with FORMATS.md, the cockpit skill and the revise agent --
  {
    const bodiesFile = 'apps/desktop/src/utils/actions/bodies.ts';
    const formatsFile = 'plugins/port/docs/FORMATS.md';
    const bodies = (await import(pathToFileURL(join(root, bodiesFile)).href)) as {
      gateClearedBody: (route: 'revision' | 'review', opts?: { rebaseDecisions?: { id: string; path: string; letter: string; label: string }[] }) => string | null;
    };

    const formatsText = readFileSync(join(root, formatsFile), 'utf8');
    expect(formatsText.includes('Requested by the operator on `<head-sha>`, after approval:'), 'desktop-actions', `${formatsFile}'s "Changes requested" fence no longer names the exact line ${bodiesFile}'s changesRequestedBody renders`);

    // The decision line is quoted verbatim by the cockpit skill and revise-agent, which parses it back.
    const decisionLineShape = '- D<n> `path` — **<letter> <label>**';
    const gateCleared = bodies.gateClearedBody('revision', {
      rebaseDecisions: [
        { id: 'D1', path: 'src/money.ts', letter: 'B', label: 'take theirs' },
        { id: 'D2', path: 'src/format.ts', letter: 'C', label: 'keep both rounding modes' },
      ],
    });
    const decisionLines = (gateCleared ?? '').split('\n').filter((line) => line.startsWith('- D'));
    expect(
      decisionLines.length === 2 && decisionLines.every((line) => /^- D\d+ `[^`]+` — \*\*[A-Z] [^*]+\*\*$/.test(line)),
      'desktop-actions',
      `${bodiesFile}'s gateClearedBody no longer renders each rebase decision as '${decisionLineShape}'`,
    );
    for (const quoted of ['plugins/port/skills/pipeline/SKILL.md', 'plugins/port/agents/revise-agent.md']) {
      expect(
        readFileSync(join(root, quoted), 'utf8').includes(decisionLineShape),
        'desktop-actions',
        `${quoted} no longer quotes '${decisionLineShape}' — the decision line ${bodiesFile}'s gateClearedBody renders`,
      );
    }

    const reviseAgentText = readFileSync(join(root, 'plugins/port/agents/revise-agent.md'), 'utf8');
    for (const escalationLiteral of ['### D<n> — \\`path\\`', '**Recommendation: <letter>**']) {
      expect(
        reviseAgentText.includes(escalationLiteral),
        'desktop-actions',
        `plugins/port/agents/revise-agent.md no longer writes '${escalationLiteral}' — the escalation shape utils/actions/decide.ts's rebaseDecisionsOf parses`,
      );
    }
  }

  // pin: `main/claim/classify.ts`'s opt-in key set (`CLAIM_LABEL_KEYS` + `AUTO_PLAN_KEY`) ↔ `plugins/port/skills/pipeline/SKILL.md`'s "work on #N" paragraph's `<labels.X>` keys, both directions
  {
    const classifyFile = 'apps/desktop/src/main/claim/classify.ts';
    const skillFile = 'plugins/port/skills/pipeline/SKILL.md';
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

  // pin: `main/dispatch/observation.ts`'s comment templates ↔ `FORMATS.md`'s "Approval withdrawn"/"Rebase required" fences and `TICK-PROSE.md`'s per-SHA cap and integration-red escalation fences
  {
    const observationFile = 'apps/desktop/src/main/dispatch/observation.ts';
    const observationText = readFileSync(join(root, observationFile), 'utf8');

    const fenceTextOf = (docText: string, anchor: string): string | null => {
      const anchorIdx = docText.indexOf(anchor);
      if (anchorIdx === -1) return null;
      const fenceStart = docText.indexOf('```', anchorIdx);
      if (fenceStart === -1) return null;
      const fenceEnd = docText.indexOf('```', fenceStart + 3);
      if (fenceEnd === -1) return null;
      return docText.slice(fenceStart + 3, fenceEnd).trim();
    };

    // Splits on `<placeholder>` tokens and strips surrounding backticks — a JS template
    // literal escapes those, so a fragment ending on a bare backtick would never match. ---
    const fenceLiteralsOf = (fence: string): readonly string[] =>
      fence
        .split('\n')
        .flatMap((line) => line.split(/<[^>]+>/))
        .map((s) => s.trim().replace(/^`+/, '').replace(/`+$/, '').trim())
        .filter((s) => s.length >= 4);

    const docsText = pipelineDocsText();
    const skillText = pipelineSkillText();
    const fences: { readonly name: string; readonly fence: string | null }[] = [
      { name: `"Approval withdrawn" (FORMATS.md)`, fence: fenceTextOf(docsText, '### Approval withdrawn') },
      { name: `"Rebase required" (FORMATS.md)`, fence: fenceTextOf(docsText, '### Rebase required') },
      { name: `"Approval withdrawn" escalation variant (FORMATS.md)`, fence: fenceTextOf(docsText, 'Approval withdrawn — escalation variant') },
      { name: 'the per-SHA cap escalation (TICK-PROSE.md)', fence: fenceTextOf(skillText, 'Per-SHA cap.') },
      { name: 'the integration-red escalation (TICK-PROSE.md)', fence: fenceTextOf(skillText, 'integration-red-escalation-<pr>.md') },
    ];

    let violated = false;
    for (const { name, fence } of fences) {
      if (fence === null) {
        violated = true;
        fail('desktop-dispatch', `could not find the ${name} fence to compare ${observationFile} against`);
        continue;
      }
      for (const literal of fenceLiteralsOf(fence)) {
        if (!observationText.includes(literal)) {
          violated = true;
          fail('desktop-dispatch', `${observationFile} is missing '${literal}' — drifted from the ${name} fence`);
        }
      }
    }
    if (!violated) ok();
  }

  // --- The Releases screen's literals match the release skill's, in both directions. ---
  {
    const format = readFileSync(join(root, 'apps/desktop/src/utils/release/format.ts'), 'utf8');
    const skill = readFileSync(join(root, 'plugins/port/skills/release/SKILL.md'), 'utf8');

    const block = /RELEASE_LITERALS\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(format)?.[1] ?? '';
    const literals = [...block.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);

    // --- format.ts holds exactly the literals this check knows, so a new one cannot ship unpinned. ---
    {
      const missing = RELEASE_EXPECTED.filter((l) => !literals.includes(l));
      const extra = literals.filter((l) => !RELEASE_EXPECTED.includes(l));
      if (missing.length > 0) fail('desktop-release', `format.ts's RELEASE_LITERALS is missing ${missing.map((l) => `'${l}'`).join(', ')}`);
      else if (extra.length > 0) fail('desktop-release', `format.ts's RELEASE_LITERALS carries ${extra.map((l) => `'${l}'`).join(', ')}, which has no pin against SKILL.md in scripts/checks/desktop-parity-docs.ts`);
      else ok();
    }

    // --- SKILL.md still spells every literal the app writes. ---
    for (const literal of RELEASE_EXPECTED) {
      if (!skill.includes(literal)) fail('desktop-release', `plugins/port/skills/release/SKILL.md no longer contains '${literal}', which apps/desktop/src/utils/release/format.ts writes`);
      else ok();
    }
  }

  // --- PORT_STAGE_AGENTS matches the basenames of plugins/port/agents/ and
  // apps/desktop/stage-prompts/agents/, both directions. ---
  {
    const sessionsDir = 'apps/desktop/src/main/sessions';
    const classifyFile = join(root, `${sessionsDir}/classify.ts`);
    if (!existsSync(classifyFile)) {
      fail('desktop-sessions', `${sessionsDir}/classify.ts does not exist`);
    } else {
      const text = readFileSync(classifyFile, 'utf8');
      const m = /PORT_STAGE_AGENTS\s*:[^=]*=\s*\[([^\]]*)\]/.exec(text);
      if (!m) {
        fail('desktop-sessions', `${sessionsDir}/classify.ts has no 'PORT_STAGE_AGENTS = [...]' array`);
      } else {
        const declared = new Set([...m[1].matchAll(/'([^']+)'/g)].map((t) => t[1]));
        for (const dir of ['plugins/port/agents', 'apps/desktop/stage-prompts/agents']) {
          const real = new Set(
            readdirSync(join(root, dir))
              .filter((name) => name.endsWith('.md'))
              .map((name) => name.slice(0, -'.md'.length)),
          );
          for (const name of declared) {
            if (!real.has(name)) fail('desktop-sessions', `PORT_STAGE_AGENTS names '${name}', which has no ${dir}/${name}.md`);
          }
          for (const name of real) {
            if (!declared.has(name)) fail('desktop-sessions', `${dir}/${name}.md has no counterpart in PORT_STAGE_AGENTS`);
          }
          if (declared.size > 0 && [...declared].every((name) => real.has(name)) && [...real].every((name) => declared.has(name))) {
            ok();
          }
        }
      }
    }

    // The wildcard-prefix rung reads /<prefix>:(pipeline|implement) — both must exist as real skill directories.
    let skillDirsOk = true;
    for (const skillName of ['pipeline', 'implement']) {
      if (!existsSync(join(root, 'plugins/port/skills', skillName))) {
        skillDirsOk = false;
        fail('desktop-sessions', `plugins/port/skills/${skillName} does not exist — the role ladder's first-prompt rung names it`);
      }
    }
    if (skillDirsOk) ok();
  }

  // --- The SESSION REQUIRED rendering in link.ts matches PIPELINE.md's own — a
  // byte-identical contract between the cockpit and this app. ---
  {
    const linkRel = 'apps/desktop/src/main/state/link.ts';
    const linkPath = join(root, linkRel);
    if (!existsSync(linkPath)) {
      fail('desktop-state', `${linkRel} does not exist`);
    } else {
      const linkText = readFileSync(linkPath, 'utf8');
      const linkMatch = /SESSION_REQUIRED_PREFIX\s*=\s*'([^']*)'/.exec(linkText);
      const pipelineText = readFileSync(join(root, 'plugins/port/docs/PIPELINE.md'), 'utf8');
      const pipelineMatch = /```\n(> \*\*SESSION REQUIRED:\*\*) [^\n]*\n```/.exec(pipelineText);
      if (!linkMatch) {
        fail('desktop-state', `${linkRel} has no 'SESSION_REQUIRED_PREFIX' string constant`);
      } else if (!pipelineMatch) {
        fail('desktop-state', `plugins/port/docs/PIPELINE.md's "The marker" section has no canonical fenced rendering to compare against`);
      } else {
        const canonical = `${pipelineMatch[1]} `;
        expect(!(linkMatch[1] !== canonical), 'desktop-state', `${linkRel}'s SESSION_REQUIRED_PREFIX is ${JSON.stringify(linkMatch[1])}, but PIPELINE.md's canonical rendering is ${JSON.stringify(canonical)}`);
      }
    }
  }
}
