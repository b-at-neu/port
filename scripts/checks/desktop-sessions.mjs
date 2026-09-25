import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '../lib/files.mjs';

// Issue 78: apps/desktop/src/main/sessions/ is the app's only reader of local
// Claude transcripts. Three assertions pin its plan's decisions mechanically,
// dependency-free and regex-based, in the shape of desktop-registry.mjs's own
// guards — reading these directories by explicit path (never walk('apps/'),
// which descends into node_modules).
export default async function ({ fail, ok }) {
  const sessionsDir = 'apps/desktop/src/main/sessions';
  const sharedSessionsDir = 'apps/desktop/src/shared/sessions';
  const srcDir = join(root, 'apps/desktop/src');
  const sdkRel = `${sessionsDir}/sdk.ts`;
  const runtimeSdkRel = 'apps/desktop/src/main/runtime/sdk.ts';
  const sdkAllowlist = new Set([sdkRel, runtimeSdkRel]);
  const allFiles = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));

  // --- The Agent SDK is referenced under apps/desktop/src/ only in the two allowlisted seams ---
  // guard(#78, #97): a second reader spawning the SDK directly instead of
  // going through one of the two lazy-imported seams — the session reader
  // (#78) and the runtime probe (#97). Matched only as an import specifier
  // (`from '...'` or `import(...)`), never a bare substring — `runtime/
  // locate.test.ts`'s own fixtures legitimately spell the SDK's per-platform
  // package name out as a path string (what a resolved `claude` binary
  // sitting inside it looks like), never as an import.
  {
    const importSpecifierRe = /(?:from\s+|import\()\s*['"]@anthropic-ai\/claude-agent-sdk['"]/;
    const seenAllowlisted = new Set();
    let extraReferences = false;
    for (const f of allFiles) {
      const rel = relOf(f);
      const text = readFileSync(f, 'utf8');
      if (!importSpecifierRe.test(text)) continue;
      if (sdkAllowlist.has(rel)) {
        seenAllowlisted.add(rel);
        continue;
      }
      extraReferences = true;
      fail('desktop-sessions', `${rel} references '@anthropic-ai/claude-agent-sdk' — only ${[...sdkAllowlist].join(' or ')} may`);
    }
    for (const rel of sdkAllowlist) {
      if (!seenAllowlisted.has(rel)) fail('desktop-sessions', `${rel} does not reference '@anthropic-ai/claude-agent-sdk' — the guard cannot pass vacuously if the file is deleted`);
    }
    if (seenAllowlisted.size === sdkAllowlist.size && !extraReferences) ok();
  }

  // --- PORT_STAGE_AGENTS matches plugins/port/agents/'s basenames, both directions ---
  // guard(#78): the stage union or the role ladder's first-prompt rung
  // drifting from the real agents and skills it names.
  {
    const classifyFile = allFiles.find((f) => relOf(f) === `${sessionsDir}/classify.ts`);
    if (!classifyFile) {
      fail('desktop-sessions', `${sessionsDir}/classify.ts does not exist`);
    } else {
      const text = readFileSync(classifyFile, 'utf8');
      const m = /PORT_STAGE_AGENTS\s*:[^=]*=\s*\[([^\]]*)\]/.exec(text);
      if (!m) {
        fail('desktop-sessions', `${sessionsDir}/classify.ts has no 'PORT_STAGE_AGENTS = [...]' array`);
      } else {
        const declared = new Set([...m[1].matchAll(/'([^']+)'/g)].map((t) => t[1]));
        const agentsDir = join(root, 'plugins/port/agents');
        const real = new Set(
          readdirSync(agentsDir)
            .filter((name) => name.endsWith('.md'))
            .map((name) => name.slice(0, -'.md'.length)),
        );
        for (const name of declared) {
          if (!real.has(name)) fail('desktop-sessions', `PORT_STAGE_AGENTS names '${name}', which has no plugins/port/agents/${name}.md`);
        }
        for (const name of real) {
          if (!declared.has(name)) fail('desktop-sessions', `plugins/port/agents/${name}.md has no counterpart in PORT_STAGE_AGENTS`);
        }
        if (declared.size > 0 && [...declared].every((name) => real.has(name)) && [...real].every((name) => declared.has(name))) {
          ok();
        }
      }
    }

    // The wildcard-prefix rung (Decision, SessionRole ladder) reads
    // /<prefix>:(pipeline|implement) — both must exist as real skill
    // directories, or the rung is testing against nothing.
    let skillDirsOk = true;
    for (const skillName of ['pipeline', 'implement']) {
      if (!existsSync(join(root, 'plugins/port/skills', skillName))) {
        skillDirsOk = false;
        fail('desktop-sessions', `plugins/port/skills/${skillName} does not exist — the role ladder's first-prompt rung names it`);
      }
    }
    if (skillDirsOk) ok();
  }

  // --- No `running`/`alive`/`isLive` identifier or string literal in production code ---
  // guard(#78, #87): a local transcript's recency being reported as
  // liveness, the exact distinction Decision 4 exists to hold -- extended to
  // main/search/ and shared/search/ so a hit's own recency can't drift into
  // the same "running" framing either. Comments are stripped first — a doc
  // comment is allowed to *discuss* the rail (as this very file's plan
  // does, in backticks), only real code (identifiers, string literals) is
  // checked.
  {
    const dirs = [join(root, sessionsDir), join(root, sharedSessionsDir), join(root, 'apps/desktop/src/main/search'), join(root, 'apps/desktop/src/shared/search')];
    const forbidden = ['running', 'alive', 'isLive'];
    let found = false;
    for (const dir of dirs) {
      for (const f of walk(dir).filter((p) => (p.endsWith('.ts') || p.endsWith('.tsx')) && !p.endsWith('.test.ts'))) {
        const rel = relOf(f);
        const code = stripComments(readFileSync(f, 'utf8'));
        for (const word of forbidden) {
          const pattern = new RegExp(`\\b${word}\\b`);
          if (pattern.test(code)) {
            found = true;
            fail('desktop-sessions', `${rel} contains '${word}' outside a comment — this adapter reports activity, never liveness (Decision 4)`);
          }
        }
      }
    }
    if (!found) ok();
  }

  // --- transcript:tail:poll's response is a delta, never a full entries list ---
  // guard(#84): the tail-poll response (TranscriptTailPoll) must carry
  // `appended` and `patched` on its ok branch and never an `entries` field --
  // a poll that returned the whole transcript every second would defeat the
  // byte cursor's whole point, and the renderer's own no-full-re-render
  // contract depends on this staying a delta.
  {
    const file = allFiles.find((f) => relOf(f) === `${sharedSessionsDir}/transcript.ts`);
    if (!file) {
      fail('desktop-sessions', `${sharedSessionsDir}/transcript.ts does not exist`);
    } else {
      const text = readFileSync(file, 'utf8');
      const m = /export type TranscriptTailPoll =\s*([\s\S]*?)\n(?:export|$)/.exec(text);
      if (!m) {
        fail('desktop-sessions', `${sharedSessionsDir}/transcript.ts has no 'export type TranscriptTailPoll' declaration`);
      } else {
        const block = m[1];
        const hasAppended = /\bappended\s*:/.test(block);
        const hasPatched = /\bpatched\s*:/.test(block);
        const hasEntries = /\bentries\s*:/.test(block);
        if (!hasAppended || !hasPatched) {
          fail('desktop-sessions', "TranscriptTailPoll's ok branch must carry both 'appended' and 'patched' -- a poll response is a delta, never a full list (#84)");
        } else if (hasEntries) {
          fail('desktop-sessions', "TranscriptTailPoll carries an 'entries' field -- a poll response must stay a delta (appended/patched), never the whole transcript (#84)");
        } else {
          ok();
        }
      }
    }
  }

  // --- getSubagentMessages/getSessionMessages stay unreferenced ---------------
  // guard(#83): a later "simplification" onto the SDK's own message-read API
  // silently dropping every diff, since its SessionMessage carries no
  // toolUseResult. Decision 3 is "the reader parses the .jsonl itself, and
  // getSubagentMessages stays unused" — deciding against the SDK's own
  // message-read APIs.
  {
    let found = false;
    for (const f of allFiles) {
      const rel = relOf(f);
      if (rel.endsWith('.test.ts')) continue;
      const code = stripComments(readFileSync(f, 'utf8'));
      for (const name of ['getSubagentMessages', 'getSessionMessages']) {
        if (code.includes(name)) {
          found = true;
          fail('desktop-sessions', `${rel} references '${name}' outside a comment — the transcript reader parses the .jsonl itself (Decision 3), never this SDK API`);
        }
      }
    }
    if (!found) ok();
  }
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
