// Canned Settings reads for the visual harness: Usage & storage's two channels. Pure, never I/O.
import type { StorageReport, UsageSummary } from '@/types/settings'
import { GADGETS_ID, WIDGETS_ID } from './repos'

const GB = 1024 ** 3
const MB = 1024 ** 2

export function fixtureStorageReport(): StorageReport {
  return {
    appData: [
      { label: 'App data', path: '/home/you/.config/port', size: { ok: true, bytes: 38 * MB, truncated: false } },
      { label: 'Logs', path: '/home/you/.config/port/logs', size: { ok: true, bytes: 2 * MB, truncated: false } },
    ],
    pluginCache: { label: 'Plugin cache', path: '/home/you/.claude/plugins/cache', size: { ok: true, bytes: Math.round(1.2 * GB), truncated: false } },
    worktrees: [
      { repoId: WIDGETS_ID, label: 'acme/widgets', path: '/home/you/src/widgets/.claude/worktrees', size: { ok: true, bytes: Math.round(4.1 * GB), truncated: true } },
      { repoId: GADGETS_ID, label: 'acme/gadgets', path: '/home/you/src/gadgets/.claude/worktrees', size: { ok: false, message: 'EACCES: permission denied' } },
    ],
  }
}

export function fixtureUsageSummary(now: Date): UsageSummary {
  const since = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString()
  return {
    since,
    rows: [
      {
        repoId: GADGETS_ID,
        today: { costUsd: 0.42, totalTokens: 180_000, sessions: 1 },
        week: { costUsd: 3.1, totalTokens: 1_400_000, sessions: 4 },
        month: { costUsd: 3.1, totalTokens: 1_400_000, sessions: 4 },
      },
      {
        repoId: WIDGETS_ID,
        today: { costUsd: 1.23, totalTokens: 450_000, sessions: 3 },
        week: { costUsd: 18.7, totalTokens: 7_200_000, sessions: 21 },
        month: { costUsd: 18.7, totalTokens: 7_200_000, sessions: 21 },
      },
      {
        repoId: null,
        today: { costUsd: null, totalTokens: null, sessions: 0 },
        week: { costUsd: 0.9, totalTokens: 120_000, sessions: 2 },
        month: { costUsd: 0.9, totalTokens: 120_000, sessions: 2 },
      },
    ],
  }
}
