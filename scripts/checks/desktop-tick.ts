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

  // --- (12) main/tick/routing.ts's AGENT_FOR_IN_FLIGHT matches liveness.ts's -
  // buildLivenessExpected (labelKey, stage) pairs, both directions
  // guard(#292): the app's own in-flight-to-stage map silently drifting from
  // the engine's own liveness spec table — either an in-flight label cross-
  // checked against the wrong stage, or the dispatcher's own started-task
  // descriptions (`"${agent} #${n}"`) never matching a live claim at all.
  // pin: `main/tick/routing.ts`'s `AGENT_FOR_IN_FLIGHT` ↔ `scripts/port-tick/liveness.ts`'s own `buildLivenessExpected` (labelKey, stage) pairs, both directions
  {
    const routingFile = `${mainDir}/routing.ts`;
    const routingText = readFileSync(join(root, routingFile), 'utf8');
    const inFlightMatch = /const AGENT_FOR_IN_FLIGHT[^{]*\{([^}]*)\}/.exec(routingText);
    const engineText = readFileSync(join(root, 'scripts/port-tick/liveness.ts'), 'utf8');
    const specsMatch = /const specs[^=]*=\s*\[([\s\S]*?)\]\s*;/.exec(engineText);

    if (!inFlightMatch) {
      fail('desktop-tick', `${routingFile} has no 'AGENT_FOR_IN_FLIGHT = {...}' object to compare`);
    } else if (!specsMatch) {
      fail('desktop-tick', `scripts/port-tick/liveness.ts has no 'specs = [...]' array to compare buildLivenessExpected against`);
    } else {
      const appPairs = new Map([...inFlightMatch[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));
      const enginePairs = new Map(
        [...specsMatch[1].matchAll(/\[\s*'(\w+)'\s*,\s*'(\w+)'\s*,\s*'([\w-]+)'\s*\]/g)].map((m) => [m[2], m[3].replace(/-agent$/, '')]),
      );
      const allKeys = new Set([...appPairs.keys(), ...enginePairs.keys()]);
      const mismatches = [...allKeys].filter((key) => appPairs.get(key) !== enginePairs.get(key));
      if (mismatches.length > 0) {
        fail('desktop-tick', `${routingFile}'s AGENT_FOR_IN_FLIGHT and scripts/port-tick/liveness.ts's buildLivenessExpected disagree on: ${mismatches.join(', ')}`);
      } else {
        ok();
      }
    }
  }

  // --- (13) main/tick/routing.ts's REFRESH_PAIR matches reconcile.ts's own ---
  // REFRESH_PAIR, both directions
  // guard(#292): the one sanctioned co-present label pair silently drifting
  // between the engine and the app — either side would then tolerate (or
  // reject) a pair of labels the other disagrees on.
  // pin: `main/tick/routing.ts`'s `REFRESH_PAIR` ↔ `scripts/port-tick/reconcile.ts`'s own `REFRESH_PAIR`, both directions
  {
    const routingFile = `${mainDir}/routing.ts`;
    const routingText = readFileSync(join(root, routingFile), 'utf8');
    const appMatch = /const REFRESH_PAIR[^=]*=\s*\[([^\]]*)\]/.exec(routingText);
    const engineText = readFileSync(join(root, 'scripts/port-tick/reconcile.ts'), 'utf8');
    const engineMatch = /const REFRESH_PAIR\s*=\s*\[([^\]]*)\]/.exec(engineText);

    if (!appMatch) {
      fail('desktop-tick', `${routingFile} has no 'REFRESH_PAIR = [...]' array to compare`);
    } else if (!engineMatch) {
      fail('desktop-tick', `scripts/port-tick/reconcile.ts has no 'REFRESH_PAIR = [...]' array to compare`);
    } else {
      const appKeys = [...appMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
      const engineKeys = [...engineMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
      if (appKeys.length !== engineKeys.length || appKeys.some((k, i) => k !== engineKeys[i])) {
        fail('desktop-tick', `${routingFile}'s REFRESH_PAIR (${appKeys.join(', ')}) and scripts/port-tick/reconcile.ts's (${engineKeys.join(', ')}) disagree`);
      } else {
        ok();
      }
    }
  }

  // --- (14) main/dispatch/observation.ts's label table matches writes.ts's ---
  // own, found by calling each write with an identity labels map, both
  // directions
  // guard(#292): the app's own `observationWrite` label plan silently
  // drifting from the cockpit's own `writes.ts` table it was ported from —
  // found by actually calling each write with an identity labels map (label
  // name === label key) and parsing the add/remove flags off the resulting
  // `gh` command, rather than a second hand-transcribed table that could
  // drift from both.
  // pin: `main/dispatch/observation.ts`'s `observationWrite` label plan ↔ `scripts/port-tick/writes.ts`'s own write functions, both directions
  {
    const observationPath = join(root, 'apps/desktop/src/main/dispatch/observation.ts');
    const writesPath = join(root, 'scripts/port-tick/writes.ts');
    const observationModule = await import(pathToFileURL(observationPath).href);
    const writesModule = await import(pathToFileURL(writesPath).href);

    const identityLabels: Record<string, string> = new Proxy({}, { get: (_t, key: string) => key }) as Record<string, string>;
    const identityVocabulary = { labels: [] as any[] };
    const baseItem = { stages: [] as any[], assignees: [] as string[] };
    const flagsOf = (command: string) => ({
      add: /--add-label "([^"]+)"/.exec(command)?.[1] ?? null,
      remove: /--remove-label "([^"]+)"/.exec(command)?.[1] ?? null,
    });

    const cases: Array<{ readonly name: string; readonly app: () => { readonly add: readonly string[]; readonly remove: readonly string[] }; readonly engine: () => { readonly command: string } }> = [
      {
        name: 'liveness-reset',
        app: () => observationModule.observationWrite({ kind: 'liveness-reset', number: 1, itemKind: 'issue', inFlight: 'planning', retryKey: 'ready' }, baseItem, identityVocabulary, 'dev'),
        engine: () => writesModule.livenessResetWrite({ repo: 'o/r', labels: identityLabels, item: 1, fromKey: 'planning', toKey: 'ready' }),
      },
      {
        name: 'cycle-cap',
        app: () => observationModule.observationWrite({ kind: 'cycle-cap', number: 1, itemKind: 'pull-request', count: 5, cap: 5 }, baseItem, identityVocabulary, 'dev'),
        engine: () => writesModule.cycleCapWrite({ repo: 'o/r', labels: identityLabels, number: 1 }),
      },
      {
        name: 'zero-diff',
        app: () => observationModule.observationWrite({ kind: 'zero-diff', number: 1, itemKind: 'pull-request', count: 1, headRefOid: 'abc' }, baseItem, identityVocabulary, 'dev'),
        engine: () => writesModule.zeroDiffWrite({ repo: 'o/r', labels: identityLabels, number: 1 }),
      },
      {
        name: 'refresh',
        app: () => observationModule.observationWrite({ kind: 'refresh', number: 1, itemKind: 'pull-request', sourceLabel: 'readyForReview', headRefOid: 'abc', count: 1 }, baseItem, identityVocabulary, 'dev'),
        engine: () => writesModule.refreshSweepWrite({ repo: 'o/r', labels: identityLabels, candidate: { number: 1, sourceLabelKey: 'readyForReview' }, decision: { action: 'refresh' } }),
      },
      {
        name: 'refresh-stuck',
        app: () =>
          observationModule.observationWrite({ kind: 'refresh-stuck', number: 1, itemKind: 'pull-request', sourceLabel: 'readyForReview', reason: 'same-sha', sha: 'abc', count: 1 }, baseItem, identityVocabulary, 'dev'),
        engine: () => writesModule.refreshSweepWrite({ repo: 'o/r', labels: identityLabels, candidate: { number: 1, sourceLabelKey: 'readyForReview' }, decision: { action: 'escalate', reason: 'same-sha' } }),
      },
      {
        name: 'withdraw-approval',
        app: () => observationModule.observationWrite({ kind: 'withdraw-approval', number: 1, itemKind: 'pull-request', red: [], headRefOid: 'abc' }, baseItem, identityVocabulary, 'dev'),
        engine: () => writesModule.approvalWithdrawnWrite({ repo: 'o/r', labels: identityLabels, number: 1 }),
      },
    ];

    let violated = false;
    for (const { name, app, engine } of cases) {
      const appPlan = app();
      const engineFlags = flagsOf(engine().command);
      const appAdd = appPlan.add[0] ?? null;
      const appRemove = appPlan.remove[0] ?? null;
      if (appAdd !== engineFlags.add || appRemove !== engineFlags.remove) {
        violated = true;
        fail(
          'desktop-tick',
          `observation.ts's '${name}' write (add ${String(appAdd)}, remove ${String(appRemove)}) disagrees with writes.ts's own (add ${String(engineFlags.add)}, remove ${String(engineFlags.remove)})`,
        );
      }
    }
    if (!violated) ok();
  }
}
