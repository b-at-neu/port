// Layer 1 checks for the parity harness: computeParity against its decision-case
// table, join-key field names pinned both directions, and parity.ts's write-only-adjacent boundary.
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

/** Projects computeParity's result down to the shape parity.cases.json's `expected`
 *  carries — counts plus each pair's extraApp/missingApp/mismatch kinds. */
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

/** Extracts field names from a single-line `{ key: expr }` object literal — flat, no nested braces. */
function extractObjectKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const m of text.matchAll(/\b([A-Za-z][A-Za-z0-9]*)\s*:/g)) keys.add(m[1]);
  return keys;
}

export default async function ({ expect, fail, ok }: Reporter) {
  const { computeParity } = await importEngine(`${TICK_DIR}/parity.ts`);

  // --- 1. computeParity asserted against every row of parity.cases.json ----
  // guard: the parity diff drifting from the behaviour its decision-case table records.
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
      expect(!(gotStr !== expStr), 'tick-parity-cases', `parity.cases.json — '${c.name}': expected ${expStr}, got ${gotStr}`);
    }
  }

  // --- 2. The dispatch join-key field names, pinned both directions -------
  // guard: a rename on either side of the join key (item/stage) going unnoticed, since plain JSON escapes the type checker.
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
          expect(desktopKeys.has(key), 'tick-parity-fields', `${TYPES_FILE}'s DesktopDispatchEvent is missing '${key}', which the dispatch join key needs`);
          expect(cockpitKeys.has(key), 'tick-parity-fields', `${TICK_DIR}/events.ts's dispatch mapping is missing '${key}', which the dispatch join key needs`);
        }
      }
    }
  }

  // --- 3. The contention join fields, pinned both directions --------------
  // guard: the same join-key-drift risk, for the contention diff's blocker/depth fields.
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
          expect(desktopKeys.has(key), 'tick-parity-fields', `${TICK_TYPES_FILE}'s TickContention is missing '${key}', which the contention diff needs`);
          expect(cockpitKeys.has(key), 'tick-parity-fields', `${TICK_DIR}/events.ts's held mapping is missing '${key}', which the contention diff needs`);
        }
      }
    }
  }

  // --- 4. parity.ts imports neither events.ts nor report.ts ---------------
  // guard: parity.ts must stay a pure diff over already-parsed arrays, never reaching for the trajectory record's own reader/writer.
  {
    const parityPath = join(root, TICK_DIR, 'parity.ts');
    const text = readFileSync(parityPath, 'utf8');
    expect(!/from\s+['"]\.\/(events|report)\.ts['"]/.test(text), 'tick-parity-boundary', `${TICK_DIR}/parity.ts imports events.ts or report.ts — a pure diff must never read either trajectory file itself`);
  }

  // --- 5. report.ts's --desktop-events mode calls computeParity -----------
  // guard: the reader must delegate to parity.ts, never re-derive the diff itself.
  {
    const reportText = readFileSync(join(root, TICK_DIR, 'report.ts'), 'utf8');
    expect(reportText.includes('computeParity'), 'tick-parity-boundary', `${TICK_DIR}/report.ts never calls computeParity — the --desktop-events mode must delegate to parity.ts, never re-derive the diff`);
    expect(/from\s+['"]\.\/parity\.ts['"]/.test(reportText), 'tick-parity-boundary', `${TICK_DIR}/report.ts does not import from ./parity.ts`);
  }

  // --- 6. Every .ts file under scripts/port-tick/ is still enumerable ------
  // Defensive: an empty walk would make every check above pass vacuously.
  {
    const files = walk(join(root, TICK_DIR)).filter((f) => f.endsWith('.ts'));
    expect(files.some((f) => relOf(f) === `${TICK_DIR}/parity.ts`), 'tick-parity-boundary', `${TICK_DIR}/parity.ts was not found by the directory walk — the scan itself is broken`);
  }
}
