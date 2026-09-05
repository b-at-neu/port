import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '../lib/files.mjs';

// #78: apps/desktop/src/main/sessions/ is the app's only reader of local
// Claude transcripts. Three assertions pin its plan's decisions mechanically,
// dependency-free and regex-based, in the shape of desktop-registry.mjs's own
// guards — reading these directories by explicit path (never walk('apps/'),
// which descends into node_modules).
export default async function ({ fail, ok }) {
  const sessionsDir = 'apps/desktop/src/main/sessions';
  const sharedSessionsDir = 'apps/desktop/src/shared/sessions';
  const srcDir = join(root, 'apps/desktop/src');
  const sdkRel = `${sessionsDir}/sdk.ts`;
  const allFiles = walk(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));

  // --- The Agent SDK is referenced under apps/desktop/src/ only in sdk.ts, and sdk.ts does reference it ---
  {
    let sdkHasIt = false;
    let extraReferences = false;
    for (const f of allFiles) {
      const rel = relOf(f);
      const text = readFileSync(f, 'utf8');
      if (!text.includes('@anthropic-ai/claude-agent-sdk')) continue;
      if (rel === sdkRel) {
        sdkHasIt = true;
        continue;
      }
      extraReferences = true;
      fail('desktop-sessions', `${rel} references '@anthropic-ai/claude-agent-sdk' — only ${sdkRel} may (Decision 3)`);
    }
    if (!sdkHasIt) {
      fail('desktop-sessions', `${sdkRel} does not reference '@anthropic-ai/claude-agent-sdk' — the guard cannot pass vacuously if the file is deleted`);
    } else if (!extraReferences) {
      ok();
    }
  }

  // --- PORT_STAGE_AGENTS matches plugins/port/agents/'s basenames, both directions ---
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
    for (const skillName of ['pipeline', 'implement']) {
      if (!existsSync(join(root, 'plugins/port/skills', skillName))) {
        fail('desktop-sessions', `plugins/port/skills/${skillName} does not exist — the role ladder's first-prompt rung names it`);
      }
    }
    ok();
  }

  // --- No `running`/`alive`/`isLive` identifier or string literal in production code ---
  // Comments are stripped first — a doc comment is allowed to *discuss* the
  // rail (as this very file's plan does, in backticks), only real code
  // (identifiers, string literals) is checked.
  {
    const dirs = [join(root, sessionsDir), join(root, sharedSessionsDir)];
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
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
