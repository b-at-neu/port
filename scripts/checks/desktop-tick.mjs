import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson, walk, relOf } from '../lib/files.mjs';

// Issue 105: apps/desktop/src/main/tick/ turns one repository's reconciled
// RepositoryState into a TickReport — it computes, it never writes (dispatch
// is issue 106, the retry write is issue 94). Seven assertions pin its
// decisions mechanically, in the shape of desktop-actions.mjs's and
// desktop-local.mjs's own guards.
export default async function ({ fail, ok }) {
  const mainDir = 'apps/desktop/src/main/tick';
  const sharedDir = 'apps/desktop/src/shared/tick';
  const mainFiles = walk(join(root, mainDir)).filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts'));
  const mainAllFiles = walk(join(root, mainDir)).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  const sharedFiles = walk(join(root, sharedDir)).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));

  // --- (1) main/tick/ has source files at all ---------------------------------
  // guard(#105): the directory this whole ticket adds being deleted with
  // nothing to catch it.
  if (mainFiles.length === 0) {
    fail('desktop-tick', `${mainDir} has no source files — the guard cannot pass vacuously if the directory is deleted`);
    return;
  }
  ok();

  // --- (2) No file under main/tick/ reaches I/O -------------------------------
  // guard(#105): the tick module — a pure decision layer, per its own header
  // — silently gaining a `gh`/`git` call or a Node builtin, instead of
  // deciding over an already-built RepositoryState.
  {
    let violated = false;
    for (const f of mainFiles) {
      const rel = relOf(f);
      const codeOnly = readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      if (/from\s+['"]\.\.\/platform/.test(codeOnly)) {
        violated = true;
        fail('desktop-tick', `${rel} imports from ../platform — main/tick/ decides over an already-built state, it never reaches I/O`);
      }
      if (/from\s+['"]node:/.test(codeOnly)) {
        violated = true;
        fail('desktop-tick', `${rel} imports a node: builtin — main/tick/ is a pure decision layer`);
      }
      if (/\bgh\s*\(|\bghJson\s*\(|\brunCommand\s*\(/.test(codeOnly)) {
        violated = true;
        fail('desktop-tick', `${rel} names gh(/ghJson(/runCommand( — main/tick/ computes, it never calls out`);
      }
    }
    if (!violated) ok();
  }

  // --- (3) ownership.test.ts and liveness.test.ts import a real case table ---
  // guard(#105): either test silently drifting off the shared table it
  // exists to be asserted against, so the two implementations could
  // disagree with nothing to catch it.
  {
    const pairs = [
      { test: `${mainDir}/ownership.test.ts`, table: 'scripts/port-tick/cases/ownership.cases.json' },
      { test: `${mainDir}/liveness.test.ts`, table: 'scripts/port-tick/cases/liveness.cases.json' },
    ];
    for (const { test, table } of pairs) {
      const testPath = join(root, test);
      const tablePath = join(root, table);
      const text = readFileSync(testPath, 'utf8');
      if (!text.includes('ownership.cases.json') && !text.includes('liveness.cases.json')) {
        fail('desktop-tick', `${test} does not import a cases.json table at all`);
        continue;
      }
      try {
        readFileSync(tablePath, 'utf8');
        ok();
      } catch {
        fail('desktop-tick', `${test} names ${table}, which does not resolve to a real file`);
      }
    }
  }

  // --- (4) main/tick/liveness.ts's RETRY_TRIGGER agrees with the engine's ----
  // guard(#105): the app's own stalled-claim recovery target silently
  // drifting from scripts/port-tick/liveness.mjs's own ladder — checked by
  // dynamic import of the real engine, the same idiom desktop-local.mjs
  // already uses for bin/worktrees.mjs's correlate.
  {
    const livenessFile = `${mainDir}/liveness.ts`;
    const enginePath = join(root, 'scripts/port-tick/liveness.mjs');
    const appText = readFileSync(join(root, livenessFile), 'utf8');
    // Anchored on 'const RETRY_TRIGGER', never a bare 'RETRY_TRIGGER' — this
    // file's own header comment names the export in prose before its real
    // declaration, and a bare anchor would stop at the first unrelated `{`
    // it meets first (an interface a few lines above the real object).
    const appMatch = /const RETRY_TRIGGER[^{]*\{([^}]*)\}/.exec(appText);
    if (!appMatch) {
      fail('desktop-tick', `${livenessFile} has no 'RETRY_TRIGGER = {...}' object to compare`);
    } else {
      const appPairs = new Map();
      for (const m of appMatch[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)) appPairs.set(m[1], m[2]);

      const { RETRY_TRIGGER: engineTrigger } = await import(pathToFileURL(enginePath).href);
      const engineKeys = Object.keys(engineTrigger);
      const allKeys = new Set([...appPairs.keys(), ...engineKeys]);
      const mismatches = [...allKeys].filter((key) => appPairs.get(key) !== engineTrigger[key]);
      if (mismatches.length > 0) {
        fail('desktop-tick', `${livenessFile}'s RETRY_TRIGGER and scripts/port-tick/liveness.mjs's disagree on: ${mismatches.join(', ')}`);
      } else {
        ok();
      }
    }
  }

  // --- (5) main/tick/routing.ts's AGENT_FOR_TRIGGER matches labels.json's ----
  // trigger keys, both directions
  // guard(#105): a trigger label added or retired in labels.json leaving the
  // dispatch-routing map silently out of step, either direction.
  {
    const routingFile = `${mainDir}/routing.ts`;
    const routingText = readFileSync(join(root, routingFile), 'utf8');
    const routingMatch = /const AGENT_FOR_TRIGGER[^{]*\{([^}]*)\}/.exec(routingText);
    const labelsJson = readJson('plugins/port/data/labels.json');
    const triggerKeys = new Set(labelsJson.labels.filter((l) => l.role === 'trigger').map((l) => l.key));

    if (!routingMatch) {
      fail('desktop-tick', `${routingFile} has no 'AGENT_FOR_TRIGGER = {...}' object to compare`);
    } else {
      const routingKeys = new Set([...routingMatch[1].matchAll(/(\w+)\s*:/g)].map((m) => m[1]));
      for (const key of triggerKeys) {
        if (!routingKeys.has(key)) fail('desktop-tick', `${routingFile}'s AGENT_FOR_TRIGGER is missing trigger key '${key}'`);
      }
      for (const key of routingKeys) {
        if (!triggerKeys.has(key)) fail('desktop-tick', `${routingFile}'s AGENT_FOR_TRIGGER names '${key}', which labels.json does not carry as a trigger role`);
      }
      ok();
    }
  }

  // --- (6) running/alive/isLive banned under shared/tick/ and main/tick/ -----
  // guard(#105): a local session read being presented as proof of a live
  // agent — the same absence `desktop-sessions`/`desktop-state` already pin
  // for the modules that feed this one (ENGINEERING §4: "Liveness is a
  // TaskList call, never a label inference").
  {
    let violated = false;
    for (const f of [...mainAllFiles, ...sharedFiles]) {
      const rel = relOf(f);
      const codeOnly = readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      for (const word of ['running', 'alive', 'isLive']) {
        if (new RegExp(`\\b${word}\\b`).test(codeOnly)) {
          violated = true;
          fail('desktop-tick', `${rel} declares '${word}' — this app's own liveness evidence is 'matched'/'no-record'/etc, never running/alive/isLive`);
        }
      }
    }
    if (!violated) ok();
  }

  // --- (7) shared/tick/types.ts's nextTickAt-shaped fields are string | null -
  // guard(#105): a field that cannot express "no timer" — the same bug
  // issue 62 was filed for, this time in the tick engine's own
  // renderer-safe shapes.
  {
    const typesFile = `${sharedDir}/types.ts`;
    const text = readFileSync(join(root, typesFile), 'utf8');
    const fieldRe = /readonly\s+(\w*[Nn]ext[Tt]ick[Aa]t\w*)\s*:\s*([^\n]+)/g;
    const matches = [...text.matchAll(fieldRe)];
    if (matches.length === 0) {
      fail('desktop-tick', `${typesFile} declares no nextTickAt-shaped field — the guard cannot pass vacuously if the field is removed`);
    } else {
      let violated = false;
      for (const [, name, decl] of matches) {
        if (!/string\s*\|\s*null/.test(decl)) {
          violated = true;
          fail('desktop-tick', `${typesFile}'s '${name}' is declared '${decl.trim()}' — a nextTickAt-shaped field must be 'string | null', never a bare 'string'`);
        }
      }
      if (!violated) ok();
    }
  }
}
