// Fixture mode's own canned backlog detail: the issues `backlog.ts` lists for `acme/widgets`.
import type { BacklogDetail, BacklogDetailResponse } from '@/types/backlog'
import type { ClaimBlocker } from '@/types/github'
import type { IpcMap } from '@/types/ipc'
import type { FixtureScenario } from '@/types/fixtures'
import { fixtureFailingBacklog } from './failing'
import { WIDGETS_ID } from './repos'

function link(number: number, title: string, state: string): ClaimBlocker {
  return { number, title, url: `https://github.com/acme/widgets/issues/${number}`, state }
}

function offsetHours(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * 60 * 60_000).toISOString()
}

const NO_LINKS = { ok: true, items: [], total: 0 } as const
const NO_PARENT = { ok: true, parent: null } as const

function detailFor(now: Date, number: number): BacklogDetail | undefined {
  const base = { author: 'alice', assignees: [] as readonly string[], parent: NO_PARENT, blockedBy: NO_LINKS, blocking: NO_LINKS }
  switch (number) {
    case 45:
      return {
        ...base,
        number,
        title: 'Document the webhook retry policy',
        url: 'https://github.com/acme/widgets/issues/45',
        body: '## Scope\n\nWrite down how webhook deliveries are retried.\n\n- Backoff schedule\n- When a delivery is abandoned',
        updatedAt: offsetHours(now, 24),
        assignees: ['alice'],
        parent: { ok: true, parent: link(41, 'Overhaul the notification settings', 'OPEN') },
        blockedBy: { ok: true, items: [link(43, 'Rate-limit the public search endpoint', 'OPEN'), link(40, 'Move webhooks to the queue', 'CLOSED')], total: 2 },
      }
    case 41:
      return {
        ...base,
        number,
        title: 'Overhaul the notification settings',
        url: 'https://github.com/acme/widgets/issues/41',
        body: 'Rework how notification preferences are stored and presented.',
        updatedAt: offsetHours(now, 120),
        blocking: { ok: true, items: [link(45, 'Document the webhook retry policy', 'OPEN')], total: 1 },
      }
    case 43:
      return { ...base, number, title: 'Rate-limit the public search endpoint', url: 'https://github.com/acme/widgets/issues/43', body: 'Throttle anonymous search requests.', updatedAt: offsetHours(now, 96) }
    case 47:
      return { ...base, number, title: 'Add dark mode to the email templates', url: 'https://github.com/acme/widgets/issues/47', body: 'Email templates ignore the recipient colour scheme.', updatedAt: offsetHours(now, 3) }
    default:
      return undefined
  }
}

// Pure, synchronous, never throws; every scenario but `failing` serves the same canned issues.
export function fixtureBacklogDetail(now: Date, scenario: FixtureScenario, request: IpcMap['backlog:detail']['request']): BacklogDetailResponse {
  const fetchedAt = now.toISOString()
  if (scenario === 'failing') {
    const failure = fixtureFailingBacklog(now, request.repoId)
    if (!failure.ok) return failure
  }
  const detail = request.repoId === WIDGETS_ID ? detailFor(now, request.number) : undefined
  if (detail === undefined) return { ok: false, kind: 'issue-missing', message: `#${request.number} does not exist`, fetchedAt }
  return { ok: true, detail, fetchedAt }
}
