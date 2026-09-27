import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

// Issue 105: apps/desktop/src/main/tick/ turns one repository's reconciled
// RepositoryState into a TickReport — it computes, it never writes (the
// dispatch call itself is blocked on issues 97, 98, and 101, the retry write
// is issue 94). Issue 106 adds the file-contention gate as a third ported
// family, so the report's own actionable order is the real dispatch order
// once a dispatcher exists. Ten assertions pin its decisions mechanically,
// in the shape of desktop-actions.ts's and desktop-local.ts's own guards.
export default async function ({ fail, ok }: Reporter) {
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

  // --- (3) ownership/liveness/contention tests import a real case table -----
  // guard(#105, #106): a test silently drifting off the shared table it
  // exists to be asserted against, so the two implementations could
  // disagree with nothing to catch it.
  // pin: `scripts/port-tick/cases/ownership.cases.json`/`liveness.cases.json` ↔ `main/tick/ownership.ts`'s `partitionOwnership`/`main/tick/liveness.ts`'s `classifyUnmatched`, the same tables `tick-cases` already asserts the engine's own exports against
  // pin: `scripts/port-tick/cases/contention.cases.json` ↔ `main/tick/contention.ts`'s ported `parseFilesBlock`/`gateCandidates`, the same table `tick-cases` already asserts the engine's own exports against
  {
    const pairs = [
      { test: `${mainDir}/ownership.test.ts`, table: 'scripts/port-tick/cases/ownership.cases.json' },
      { test: `${mainDir}/liveness.test.ts`, table: 'scripts/port-tick/cases/liveness.cases.json' },
      { test: `${mainDir}/contention.test.ts`, table: 'scripts/port-tick/cases/contention.cases.json' },
    ];
    for (const { test, table } of pairs) {
      const testPath = join(root, test);
      const tablePath = join(root, table);
      const text = readFileSync(testPath, 'utf8');
      const tableBasename = table.split('/').pop();
      if (!tableBasename) {
        fail('desktop-tick', `${table} has no basename to check for`);
        continue;
      }
      if (!text.includes(tableBasename)) {
        fail('desktop-tick', `${test} does not import ${tableBasename} at all`);
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
  // drifting from scripts/port-tick/liveness.ts's own ladder — checked by
  // dynamic import of the real engine, the same idiom desktop-local.ts
  // already uses for bin/worktrees.mjs's correlate.
  // pin: `main/tick/liveness.ts`'s `RETRY_TRIGGER` ↔ `scripts/port-tick/liveness.ts`'s own `RETRY_TRIGGER`, both directions, keys and values — a third copy alongside `shared/actions/plan.ts`'s own, since a recovered manual retry and a stalled claim's recovery target are different callers on different sides of the `shared/`↔`main/` boundary
  {
    const livenessFile = `${mainDir}/liveness.ts`;
    const enginePath = join(root, 'scripts/port-tick/liveness.ts');
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
        fail('desktop-tick', `${livenessFile}'s RETRY_TRIGGER and scripts/port-tick/liveness.ts's disagree on: ${mismatches.join(', ')}`);
      } else {
        ok();
      }
    }
  }

  // --- (5) main/tick/routing.ts's AGENT_FOR_TRIGGER matches labels.json's ----
  // trigger keys, both directions
  // guard(#105): a trigger label added or retired in labels.json leaving the
  // dispatch-routing map silently out of step, either direction.
  // pin: `main/tick/routing.ts`'s `AGENT_FOR_TRIGGER` keys ↔ `data/labels.json`'s `role: "trigger"` keys, both directions
  {
    const routingFile = `${mainDir}/routing.ts`;
    const routingText = readFileSync(join(root, routingFile), 'utf8');
    const routingMatch = /const AGENT_FOR_TRIGGER[^{]*\{([^}]*)\}/.exec(routingText);
    const labelsJson = readJson('plugins/port/data/labels.json');
    const triggerKeys = new Set<string>(labelsJson.labels.filter((l: any) => l.role === 'trigger').map((l: any) => l.key));

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

  // --- (8) main/tick/contention.ts's exported function names agree with ------
  // scripts/port-tick/contention.ts's own exports, both directions
  // guard(#106): the app's own port silently gaining or losing a function
  // relative to the engine it is ported from — checked by dynamic import of
  // the real engine, the same idiom (4) above already uses for
  // liveness.ts's RETRY_TRIGGER.
  {
    const contentionFile = `${mainDir}/contention.ts`;
    const enginePath = join(root, 'scripts/port-tick/contention.ts');
    const appText = readFileSync(join(root, contentionFile), 'utf8');
    const appFunctions = new Set([...appText.matchAll(/^export function (\w+)/gm)].map((m) => m[1]));

    const engineModule = await import(pathToFileURL(enginePath).href);
    const engineFunctions = new Set(Object.keys(engineModule).filter((k) => typeof engineModule[k] === 'function'));

    const allNames = new Set([...appFunctions, ...engineFunctions]);
    const mismatches = [...allNames].filter((name) => appFunctions.has(name) !== engineFunctions.has(name));
    if (mismatches.length > 0) {
      fail('desktop-tick', `${contentionFile}'s exported functions and scripts/port-tick/contention.ts's disagree on: ${mismatches.join(', ')}`);
    } else {
      ok();
    }
  }

  // --- (9) main/tick/plan.ts's occupied-set stage keys resolve in labels.json ---
  // guard(#106): a retired or renamed stage key silently emptying the
  // occupied set rather than failing here — the gate's whole premise is
  // that 'inProgress'/'prOpened' name real labels with the roles it assumes.
  // pin: `main/tick/plan.ts`'s occupied-set stage keys (`inProgress` → `in-flight`, `prOpened` → `terminal`) ↔ `data/labels.json`'s own roles
  {
    const planFile = `${mainDir}/plan.ts`;
    const planText = readFileSync(join(root, planFile), 'utf8');
    const fnMatch = /function occupiedSetOf\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(planText);
    if (!fnMatch) {
      fail('desktop-tick', `${planFile} has no 'occupiedSetOf' function to check`);
    } else {
      const keys = new Set([...fnMatch[1].matchAll(/'(\w+)'/g)].map((m) => m[1]));
      const labelsJson = readJson('plugins/port/data/labels.json');
      const roleByKey = new Map(labelsJson.labels.map((l: any) => [l.key, l.role]));
      const expected = { inProgress: 'in-flight', prOpened: 'terminal' };
      let violated = false;
      for (const [key, role] of Object.entries(expected)) {
        if (!keys.has(key)) {
          violated = true;
          fail('desktop-tick', `${planFile}'s occupiedSetOf no longer names '${key}' — the occupied set would silently drop it`);
          continue;
        }
        if (roleByKey.get(key) !== role) {
          violated = true;
          fail('desktop-tick', `${planFile}'s occupiedSetOf assumes '${key}' is role '${role}', but labels.json now has '${roleByKey.get(key)}'`);
        }
      }
      if (!violated) ok();
    }
  }

  // --- (10) schema.ts's concurrency default reads off the schema import, ------
  // never a hand-typed literal
  // guard(#106): a literal number or array silently drifting from the
  // schema's own default the moment either changes — `desktop-registry.ts`'s
  // own guard only walks string-typed defaults (`collectStringDefaults`), so
  // `concurrency`'s numeric `overlapThreshold` and array `sharedFiles` need
  // this narrower rail of their own.
  {
    const schemaFile = 'apps/desktop/src/main/registry/schema.ts';
    const text = readFileSync(join(root, schemaFile), 'utf8');
    const constIdx = text.indexOf('export const CONFIG_DEFAULTS');
    const constText = constIdx === -1 ? '' : text.slice(constIdx);
    const concurrencyMatch = /concurrency:\s*\{([^}]*)\}/.exec(constText);
    if (!concurrencyMatch) {
      fail('desktop-tick', `${schemaFile} has no 'concurrency: {...}' block in CONFIG_DEFAULTS to check`);
    } else {
      const body = concurrencyMatch[1];
      if (/:\s*\d/.test(body) || /:\s*\[/.test(body)) {
        fail('desktop-tick', `${schemaFile}'s CONFIG_DEFAULTS.concurrency carries a literal number or array rather than reading off the schema import`);
      } else if (!/schema\.properties\.concurrency/.test(body)) {
        fail('desktop-tick', `${schemaFile}'s CONFIG_DEFAULTS.concurrency does not read off 'schema.properties.concurrency'`);
      } else {
        ok();
      }
    }
  }
}
