import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '../lib/files.mjs';

// #79: apps/desktop/src/main/state/ is the app's spine — it composes
// #74/#76/#77/#78's adapters into one reconciled view and reads nothing
// itself. Four assertions pin its plan's decisions mechanically,
// dependency-free and regex-based, in the shape of desktop-github.mjs's own
// guards — reading these directories by explicit path (never walk('apps/'),
// which descends into node_modules).
export default async function ({ fail, ok }) {
  const stateDir = 'apps/desktop/src/main/state';
  const sharedStateDir = 'apps/desktop/src/shared/state';
  const files = walk(join(root, stateDir)).filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts'));

  // --- The directory has source files, so nothing below passes vacuously ---
  if (files.length === 0) {
    fail('desktop-state', `${stateDir} has no source files — the guard cannot pass vacuously if the directory is deleted`);
    return;
  }
  ok();

  // --- main/state/ composes adapters and never becomes a fifth reader --------
  // No file imports ../platform directly, and no file names gh(/ghJson(/
  // runCommand( — every read this module needs goes through main/github,
  // main/local, and main/sessions, which already hold those rails.
  {
    let found = false;
    for (const f of files) {
      const rel = relOf(f);
      const text = readFileSync(f, 'utf8');
      if (text.includes("from '../platform'") || text.includes('from "../platform"')) {
        found = true;
        fail('desktop-state', `${rel} imports '../platform' directly — main/state/ composes the three adapters, it never becomes a fifth reader`);
      }
      for (const forbidden of ['gh(', 'ghJson(', 'runCommand(']) {
        if (text.includes(forbidden)) {
          found = true;
          fail('desktop-state', `${rel} calls '${forbidden}' — main/state/ composes already-fetched results, it never spawns its own command`);
        }
      }
    }
    if (!found) ok();
  }

  // --- The SESSION REQUIRED rendering in link.ts matches PIPELINE.md's own ---
  // The marker's canonical rendering is a byte-identical contract between the
  // cockpit and this app (PIPELINE.md → "The marker") — a reworded copy here
  // means the two silently disagree about what counts as session-required.
  {
    const linkRel = `${stateDir}/link.ts`;
    const linkFile = files.find((f) => relOf(f) === linkRel);
    if (!linkFile) {
      fail('desktop-state', `${linkRel} does not exist`);
    } else {
      const linkText = readFileSync(linkFile, 'utf8');
      const linkMatch = /SESSION_REQUIRED_PREFIX\s*=\s*'([^']*)'/.exec(linkText);
      const pipelineText = readFileSync(join(root, 'plugins/port/docs/PIPELINE.md'), 'utf8');
      const pipelineMatch = /```\n(> \*\*SESSION REQUIRED:\*\*) [^\n]*\n```/.exec(pipelineText);
      if (!linkMatch) {
        fail('desktop-state', `${linkRel} has no 'SESSION_REQUIRED_PREFIX' string constant`);
      } else if (!pipelineMatch) {
        fail('desktop-state', `plugins/port/docs/PIPELINE.md's "The marker" section has no canonical fenced rendering to compare against`);
      } else {
        const canonical = `${pipelineMatch[1]} `;
        if (linkMatch[1] !== canonical) {
          fail(
            'desktop-state',
            `${linkRel}'s SESSION_REQUIRED_PREFIX is ${JSON.stringify(linkMatch[1])}, but PIPELINE.md's canonical rendering is ${JSON.stringify(canonical)}`,
          );
        } else {
          ok();
        }
      }
    }
  }

  // --- No `running`/`alive`/`isLive` identifier or string literal in production code ---
  // The same rail desktop-sessions.mjs pins for main/sessions/, extended to
  // the module that consumes its `Activity` facts — a stall verdict here must
  // stay a report derived from recency, never liveness (#78's Decision 4,
  // restated for #79's own Decision 2).
  {
    const dirs = [join(root, stateDir), join(root, sharedStateDir)];
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
            fail('desktop-state', `${rel} contains '${word}' outside a comment — a stall is a report, never liveness (#79 Decision 2)`);
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
