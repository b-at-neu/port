import type { Ticket } from '@/utils/pipeline/ticket'

export const NOW = '2026-11-23T12:00:00.000Z'

export const REPO = 'owner/repo' as Ticket['repo']

export function ticketOf(overrides: Partial<Ticket> = {}): Ticket {
  return {
    rev: 0,
    repo: REPO,
    ticket: 843,
    pr: null,
    stage: 'plan',
    status: { kind: 'queued', reason: 'new', since: NOW },
    autoPlan: false,
    reviewCycles: 0,
    runs: [],
    history: [],
    mirror: { written: [], failure: null },
    ...overrides,
  }
}
