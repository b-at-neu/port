import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, walk, relOf } from '../lib/files.mjs';

// #80: apps/desktop/src/shared/board/ and renderer/src/board/ are the first
// screen — a pure projection plus plain-DOM rendering, reading nothing
// itself. Five assertions pin its plan's decisions mechanically,
// dependency-free and regex-based, in the shape of desktop-state.mjs's own
// guards — reading these directories by explicit path (never walk('apps/'),
// which descends into node_modules).
export default async function ({ fail, ok }) {
  const boardDir = 'apps/desktop/src/shared/board';
  const rendererBoardDir = 'apps/desktop/src/renderer/src/board';
  const stateTypesFile = 'apps/desktop/src/shared/state/types.ts';
  const mainDir = 'apps/desktop/src/main';

  const boardFiles = walk(join(root, boardDir)).filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts'));

  // --- The directory has source files, so nothing below passes vacuously ---
  if (boardFiles.length === 0) {
    fail('desktop-board', `${boardDir} has no source files — the guard cannot pass vacuously if the directory is deleted`);
    return;
  }
  ok();

  // --- The board screen reads nothing itself ----------------------------------
  // No file under shared/board/ or renderer/src/ imports src/main/, a
  // node: builtin, or names gh(/runCommand( — every fact it renders arrives
  // already fetched, over IPC, from main/state/'s own watcher.
  {
    const dirs = [join(root, boardDir), join(root, 'apps/desktop/src/renderer/src')];
    let found = false;
    for (const dir of dirs) {
      for (const f of walk(dir).filter((p) => (p.endsWith('.ts') || p.endsWith('.tsx')) && !p.endsWith('.test.ts'))) {
        const rel = relOf(f);
        const text = readFileSync(f, 'utf8');
        if (/from ['"].*\/main\//.test(text) || /from ['"]\.\.\/main['"]/.test(text)) {
          found = true;
          fail('desktop-board', `${rel} imports from src/main/ — the renderer never reaches the main process directly, only over IPC`);
        }
        if (/from ['"]node:/.test(text)) {
          found = true;
          fail('desktop-board', `${rel} imports a node: builtin — this file compiles under typecheck:web, which carries no Node types`);
        }
        for (const forbidden of ['gh(', 'runCommand(']) {
          if (text.includes(forbidden)) {
            found = true;
            fail('desktop-board', `${rel} calls '${forbidden}' — the board reads nothing itself, it only projects an already-built BoardSnapshot`);
          }
        }
      }
    }
    if (!found) ok();
  }

  // --- One clock: watcher.ts is the only non-test file under main/ naming a timer ---
  {
    const timerWords = ['setTimeout', 'setInterval', 'setImmediate'];
    const offenders = [];
    for (const f of walk(join(root, mainDir)).filter((p) => (p.endsWith('.ts') || p.endsWith('.tsx')) && !p.endsWith('.test.ts'))) {
      const rel = relOf(f);
      if (rel === 'apps/desktop/src/main/state/watcher.ts') continue;
      const text = readFileSync(f, 'utf8');
      if (timerWords.some((word) => text.includes(word))) offenders.push(rel);
    }
    if (offenders.length > 0) {
      fail('desktop-board', `${offenders.join(', ')} name a timer — main/state/watcher.ts is the only file under src/main/ allowed to (#80 Decision 2)`);
    } else {
      ok();
    }
  }

  // --- SOURCE_KINDS and RepositoryFreshness's keys agree, itemStates excepted ---
  {
    const boardTypesFile = join(root, boardDir, 'types.ts');
    const boardTypesText = readFileSync(boardTypesFile, 'utf8');
    const sourceKindsMatch = /SOURCE_KINDS\s*=\s*\[([^\]]*)\]/.exec(boardTypesText);
    const stateTypesText = readFileSync(join(root, stateTypesFile), 'utf8');
    const freshnessMatch = /interface RepositoryFreshness\s*{([^}]*)}/.exec(stateTypesText);

    if (!sourceKindsMatch) {
      fail('desktop-board', `${boardDir}/types.ts has no 'SOURCE_KINDS' array literal to check`);
    } else if (!freshnessMatch) {
      fail('desktop-board', `${stateTypesFile} has no 'RepositoryFreshness' interface to check`);
    } else {
      const sourceKinds = [...sourceKindsMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
      const freshnessKeys = [...freshnessMatch[1].matchAll(/readonly\s+([A-Za-z]+):/g)].map((m) => m[1]);

      const missingFromFreshness = sourceKinds.filter((k) => !freshnessKeys.includes(k));
      const extraNonItemStates = freshnessKeys.filter((k) => k !== 'itemStates' && !sourceKinds.includes(k));

      if (missingFromFreshness.length > 0) {
        fail('desktop-board', `SOURCE_KINDS names ${missingFromFreshness.join(', ')}, absent from RepositoryFreshness's keys`);
      } else if (extraNonItemStates.length > 0) {
        fail('desktop-board', `RepositoryFreshness carries ${extraNonItemStates.join(', ')} outside SOURCE_KINDS and 'itemStates'`);
      } else if (!freshnessKeys.includes('itemStates')) {
        fail('desktop-board', `RepositoryFreshness is missing 'itemStates', the one key deliberately outside SOURCE_KINDS`);
      } else {
        ok();
      }
    }
  }

  // --- No running/alive/isLive identifier or string literal outside a comment ---
  {
    const dirs = [join(root, boardDir), join(root, rendererBoardDir)];
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
            fail('desktop-board', `${rel} contains '${word}' outside a comment — a stall is a report, never liveness (#79 Decision 2, extended to #80's own screen)`);
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
