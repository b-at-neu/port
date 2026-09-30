// Layer 1 checks for the parity harness (#111): computeParity asserted
// against its own decision-case table, the join-key field names pinned
// against the cockpit's own tickEventPayload shape (both directions), and
// parity.ts's own write-only-adjacent boundary — it imports neither
// events.ts nor report.ts, the same rail tick-events.ts already pins one
// level up (docs/ENGINEERING.md §1).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, readJson, walk, relOf } from '../lib/files.ts';
import type { Reporter } from '../lib/report.ts';

const TICK_DIR = 'scripts/port-tick';
const TYPES_FILE = 'apps/desktop/src/main/trajectory/types.ts';
const TICK_TYPES_FILE = 'apps/desktop/src/shared/tick/types.ts';

async function importEngine(rel: string): Promise<any> {
  return import(pathToFileURL(join(root, rel)).href);
}

/** Projects computeParity's raw `{ pairs, unmatchedCockpit, unmatchedDesktop }`
 *  down to the shape parity.cases.json's own `expected` carries — counts
 *  plus, per pair, each diff's `extraApp`/`missingApp` and a `mismatches[].kinds`
 *  list (never the full mismatch detail, which would make every case brittle
 *  against an unrelated field this check does not otherwise pin). */
function runParityCase(computeParity: any, input: any): any {
  const result = computeParity(input.cockpitEvents, input.desktopEvents, input.options ?? {});
  return {
    pairCount: result.pairs.length,
    unmatchedCockpitCount: result.unmatchedCockpit.length,
    unmatchedDesktopCount: result.unmatchedDesktop.length,
    dispatch: result.pairs.map((p: any) => ({ extraApp: p.dispatch.extraApp, missingApp: p.dispatch.missingApp, mismatchKinds: p.dispatch.mismatches.map((m: any) => m.kinds) })),
    contention: result.pairs.map((p: any) => ({ extraApp: p.contention.extraApp, missingApp: p.contention.missingApp, mismatchKinds: p.contention.mismatches.map((m: any) => m.kinds) })),
    ownership: result.pairs.map((p: any) => p.ownership.mismatches),
  };
}

/** Extracts the field names of a single-line `{ key: expr, key2: expr2 }`
 *  object literal — flat, no nested braces, the same shape
 *  `desktop-writes.ts`'s own `extractVariants` already parses elsewhere. */
function extractObjectKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const m of text.matchAll(/\b([A-Za-z][A-Za-z0-9]*)\s*:/g)) keys.add(m[1]);
  return keys;
}

export default async function ({ fail, ok }: Reporter) {
  const { computeParity } = await importEngine(`${TICK_DIR}/parity.ts`);

  // --- 1. computeParity asserted against every row of parity.cases.json ----
  // guard(#111): the parity diff silently drifting from the behaviour its
  // own decision-case table records, the same "twelve decision families"
  // idiom tick.ts's own runCase applies to every other pure tick-engine
  // module — kept in its own file since parity.ts deliberately never
  // imports events.ts/report.ts, so it cannot join tick.ts's own family
  // table without breaking that same import boundary.
  {
    const table = readJson(`${TICK_DIR}/cases/parity.cases.json`);
    for (const c of table.cases) {
      if (c.function !== 'computeParity') {
        fail('tick-parity-cases', `parity.cases.json: case '${c.name}' names unknown function '${c.function}'`);
        continue;
      }
      const got = runParityCase(computeParity, c.input);
      const gotStr = JSON.stringify(got);
      const expStr = JSON.stringify(c.expected);
      if (gotStr !== expStr) {
        fail('tick-parity-cases', `parity.cases.json — '${c.name}': expected ${expStr}, got ${gotStr}`);
      } else {
        ok();
      }
    }
  }

  // --- 2. The dispatch join-key field names, pinned both directions -------
  // guard(#111): a rename on either side of the diff's join key (`item`,
  // `stage`) going unnoticed until a real parity run silently stops
  // matching anything — the two sides are plain JSON, so nothing here is
  // caught by the type checker.
  // pin: `apps/desktop/src/main/trajectory/types.ts`'s `DesktopDispatchEvent` ↔ `scripts/port-tick/events.ts`'s `tickEventPayload` dispatch mapping — the `item`/`stage` join key, both directions
  {
    const typesText = readFileSync(join(root, TYPES_FILE), 'utf8');
    const dispatchInterface = /interface DesktopDispatchEvent \{([^}]*)\}/.exec(typesText);
    if (!dispatchInterface) {
      fail('tick-parity-fields', `${TYPES_FILE} no longer declares 'interface DesktopDispatchEvent'`);
    } else {
      const desktopKeys = extractObjectKeys(dispatchInterface[1]);
      const eventsText = readFileSync(join(root, TICK_DIR, 'events.ts'), 'utf8');
      const dispatchMapping = /\(d: any\)\s*=>\s*\(\{([^}]*)\}\)/.exec(eventsText);
      if (!dispatchMapping) {
        fail('tick-parity-fields', `${TICK_DIR}/events.ts: could not find tickEventPayload's dispatch mapping literal`);
      } else {
        const cockpitKeys = extractObjectKeys(dispatchMapping[1]);
        for (const key of ['item', 'stage']) {
          if (!desktopKeys.has(key)) fail('tick-parity-fields', `${TYPES_FILE}'s DesktopDispatchEvent is missing '${key}', which the dispatch join key needs`);
          else ok();
          if (!cockpitKeys.has(key)) fail('tick-parity-fields', `${TICK_DIR}/events.ts's dispatch mapping is missing '${key}', which the dispatch join key needs`);
          else ok();
        }
      }
    }
  }

  // --- 3. The contention join fields, pinned both directions --------------
  // guard(#111): the same silent-join-key-drift risk, for the contention
  // diff's own three comparison fields.
  // pin: `apps/desktop/src/shared/tick/types.ts`'s `TickContention` ↔ `scripts/port-tick/events.ts`'s `tickEventPayload` held mapping — `blocker`/`depth`, both directions
  {
    const tickTypesText = readFileSync(join(root, TICK_TYPES_FILE), 'utf8');
    const contentionInterface = /interface TickContention \{([^}]*)\}/.exec(tickTypesText);
    if (!contentionInterface) {
      fail('tick-parity-fields', `${TICK_TYPES_FILE} no longer declares 'interface TickContention'`);
    } else {
      const desktopKeys = extractObjectKeys(contentionInterface[1]);
      const eventsText = readFileSync(join(root, TICK_DIR, 'events.ts'), 'utf8');
      const heldMapping = /\(h: any\)\s*=>\s*\(\{([^}]*)\}\)/.exec(eventsText);
      if (!heldMapping) {
        fail('tick-parity-fields', `${TICK_DIR}/events.ts: could not find tickEventPayload's held mapping literal`);
      } else {
        const cockpitKeys = extractObjectKeys(heldMapping[1]);
        for (const key of ['blocker', 'depth']) {
          if (!desktopKeys.has(key)) fail('tick-parity-fields', `${TICK_TYPES_FILE}'s TickContention is missing '${key}', which the contention diff needs`);
          else ok();
          if (!cockpitKeys.has(key)) fail('tick-parity-fields', `${TICK_DIR}/events.ts's held mapping is missing '${key}', which the contention diff needs`);
          else ok();
        }
      }
    }
  }

  // --- 4. parity.ts imports neither events.ts nor report.ts ---------------
  // guard(#111): parity.ts silently reaching for the trajectory record's own
  // reader/writer, breaking its "pure diff over already-parsed arrays" rail
  // and reintroducing the exact coupling the write-only rail (tick-events.ts)
  // already forbids one level up.
  {
    const parityPath = join(root, TICK_DIR, 'parity.ts');
    const text = readFileSync(parityPath, 'utf8');
    if (/from\s+['"]\.\/(events|report)\.ts['"]/.test(text)) {
      fail('tick-parity-boundary', `${TICK_DIR}/parity.ts imports events.ts or report.ts — a pure diff must never read either trajectory file itself`);
    } else {
      ok();
    }
  }

  // --- 5. report.ts's --desktop-events mode calls computeParity -----------
  // guard(#111): the reader gaining its own re-derivation of the diff
  // instead of calling parity.ts's own exported function.
  {
    const reportText = readFileSync(join(root, TICK_DIR, 'report.ts'), 'utf8');
    if (!reportText.includes('computeParity')) {
      fail('tick-parity-boundary', `${TICK_DIR}/report.ts never calls computeParity — the --desktop-events mode must delegate to parity.ts, never re-derive the diff`);
    } else {
      ok();
    }
    if (!/from\s+['"]\.\/parity\.ts['"]/.test(reportText)) {
      fail('tick-parity-boundary', `${TICK_DIR}/report.ts does not import from ./parity.ts`);
    } else {
      ok();
    }
  }

  // --- 6. Every .ts file under scripts/port-tick/ is still enumerable ------
  // Defensive: an empty walk would make every check above pass vacuously.
  {
    const files = walk(join(root, TICK_DIR)).filter((f) => f.endsWith('.ts'));
    if (!files.some((f) => relOf(f) === `${TICK_DIR}/parity.ts`)) {
      fail('tick-parity-boundary', `${TICK_DIR}/parity.ts was not found by the directory walk — the scan itself is broken`);
    } else {
      ok();
    }
  }
}
