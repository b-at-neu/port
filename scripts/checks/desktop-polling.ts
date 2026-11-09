import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '#lib/files.ts';
import type { Reporter } from '#lib/report.ts';

// pin: `types/board.ts`'s fast-check floor ↔ `docs/ENGINEERING.md` §6's cost figures
export default async function ({ expect, fail, ok }: Reporter) {
  const boardTypesFile = 'apps/desktop/src/types/board.ts';
  const scheduleFile = 'apps/desktop/src/main/state/schedule.ts';
  const watcherFile = 'apps/desktop/src/main/state/watcher.ts';
  const engineeringFile = 'docs/ENGINEERING.md';
  const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
  const numeral = (text: string | undefined) => Number((text ?? '').replace(/_/g, ''));
  const HOUR_MS = 3_600_000;

  // The documented relationship: one repository alone fits the share at the floor, a second one does not.
  const relation = (floorMs: number, cost: number, share: number) => {
    const worst = (HOUR_MS / floorMs) * cost;
    return { worst, oneFits: worst <= share, twoOverflow: 2 * worst > share };
  };

  // --- Fast-check floor — the documented cost relationship ---
  {
    const board = read(boardTypesFile);
    const floorText = /export const GITHUB_PRECHECK_INTERVAL_MS = ([\d_]+)/.exec(board)?.[1];
    const baseBlock = /export const SOURCE_BASE_INTERVAL_MS[^{]*\{([^}]*)\}/.exec(board)?.[1];
    const baseText = baseBlock === undefined ? undefined : /github: ([\d_]+)/.exec(baseBlock)?.[1];
    const shareText = /export const BUDGET_SHARE = ([\d._]+)/.exec(board)?.[1];
    const limitText = /export const DEFAULT_GRAPHQL_LIMIT = ([\d_]+)/.exec(board)?.[1];

    const missing = [
      ['GITHUB_PRECHECK_INTERVAL_MS', floorText],
      ['SOURCE_BASE_INTERVAL_MS.github', baseText],
      ['BUDGET_SHARE', shareText],
      ['DEFAULT_GRAPHQL_LIMIT', limitText],
    ].filter(([, text]) => text === undefined).map(([name]) => name);
    if (missing.length > 0) {
      fail('desktop-polling', `${boardTypesFile} no longer declares ${missing.join(', ')} in a shape this check can parse — it cannot pass vacuously`);
      return;
    }
    ok();

    const engineering = read(engineeringFile);
    const start = engineering.indexOf('## 6. Performance');
    if (start === -1) {
      fail('desktop-polling', `${engineeringFile} has no "## 6. Performance" section — the cost figures have nowhere to be pinned`);
      return;
    }
    const rest = engineering.slice(start + 1);
    const end = rest.indexOf('\n## ');
    const section = end === -1 ? rest : rest.slice(0, end);
    const costText = /costs (\d+), measured live/.exec(section)?.[1];
    if (costText === undefined) {
      fail('desktop-polling', `${engineeringFile} §6 no longer states the measured sweep cost as "costs <n>, measured live"`);
      return;
    }
    ok();

    const floor = numeral(floorText);
    const base = numeral(baseText);
    const cost = Number(costText);
    const share = numeral(shareText) * numeral(limitText);
    const fmt = (n: number) => n.toLocaleString('en-US');
    const floorS = floor / 1000;
    const sweepS = base / 1000;
    const perHour = HOUR_MS / floor;
    const { worst, oneFits, twoOverflow } = relation(floor, cost, share);

    const literals = [
      [`${sweepS}s full sweep`, 'SOURCE_BASE_INTERVAL_MS.github'],
      [`${floorS}s issues-list ETag pre-check`, 'GITHUB_PRECHECK_INTERVAL_MS'],
      [`at most ${fmt(perHour)} \`core\` points`, 'GITHUB_PRECHECK_INTERVAL_MS'],
      [`at ${cost} points a sweep`, 'the measured sweep cost'],
      [`${floorS}s floor projects at most ${fmt(worst)}`, 'GITHUB_PRECHECK_INTERVAL_MS and the measured sweep cost'],
      [`${fmt(share)}-point share`, 'BUDGET_SHARE and DEFAULT_GRAPHQL_LIMIT'],
      ['Fast-check floor — the documented cost relationship', 'this check\'s own name'],
    ] as const;
    for (const [literal, source] of literals) {
      expect(section.includes(literal), 'desktop-polling', `${engineeringFile} §6 no longer contains "${literal}" — derived from ${source}, so the prose and the constants have drifted`);
    }

    expect(floor < base, 'desktop-polling', 'the fast-check floor is no longer under the full-sweep cadence');
    expect(oneFits, 'desktop-polling', `at ${floorS}s one repository alone would exceed the ${fmt(share)}-point share`);
    expect(twoOverflow, 'desktop-polling', `§6's "from the second repository on the share math sets the gap" no longer holds — two repositories at ${floorS}s fit the share`);

    expect(read(scheduleFile).includes('floorMs: GITHUB_PRECHECK_INTERVAL_MS'), 'desktop-polling', `${scheduleFile} no longer passes floorMs: GITHUB_PRECHECK_INTERVAL_MS — the fast floor has lost its one home`);
    const watcher = read(watcherFile);
    expect(watcher.includes('githubSweepGapMs(') && !watcher.includes('floorMs:'), 'desktop-polling', `${watcherFile} must call githubSweepGapMs and never name floorMs itself — there is one home for the fast floor`);
  }

  // --- The derivation catches a breach: a 5s floor must fail the one-repository half ---
  {
    const breach = relation(5_000, 5, 2_500);
    expect(!breach.oneFits, 'desktop-polling', 'the relation helper passes a 5s floor — the one-repository breach is no longer detectable');
  }
}
