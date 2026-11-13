// Fixture mode's own canned backlog: one populated scenario for `acme/widgets`.
import type { BacklogItem, BacklogResponse, ChildrenRead, ParentRead } from '@/types/backlog'
import type { BlockerRead } from '@/types/github'
import type { RepoId } from '@/utils/repos'
import { WIDGETS_ID } from './repos'

const VIEWER = 'octo-dev'

const UNBLOCKED: BlockerRead = { ok: true, open: [], shown: 0, total: 0 }
const NO_PARENT: ParentRead = { ok: true, parent: null }
const NO_CHILDREN: ChildrenRead = { ok: true, children: [], shown: 0, total: 0 }

// A second, closed blocker counts toward `shown`/`total` but never appears in `open`.
const BLOCKED_BY_43: BlockerRead = {
  ok: true,
  open: [{ number: 43, title: 'Rate-limit the public search endpoint', url: 'https://github.com/acme/widgets/issues/43', state: 'OPEN' }],
  shown: 2,
  total: 2,
}

const BLOCKED_BY_39: BlockerRead = {
  ok: true,
  open: [{ number: 39, title: 'Migrate stored notification preferences', url: 'https://github.com/acme/widgets/issues/39', state: 'OPEN' }],
  shown: 1,
  total: 1,
}

const BLOCKING_45: BlockerRead = {
  ok: true,
  open: [{ number: 45, title: 'Document the webhook retry policy', url: 'https://github.com/acme/widgets/issues/45', state: 'OPEN' }],
  shown: 1,
  total: 1,
}

// The notification epic's sub-issues: one done, one claimed, one open and waiting on the claimed one.
const EPIC_41_CHILDREN: ChildrenRead = {
  ok: true,
  children: [
    { number: 38, title: 'Audit the current notification channels', state: 'CLOSED', claimed: false, blockers: UNBLOCKED },
    { number: 39, title: 'Migrate stored notification preferences', state: 'OPEN', claimed: true, blockers: UNBLOCKED },
    { number: 43, title: 'Rate-limit the public search endpoint', state: 'OPEN', claimed: false, blockers: BLOCKED_BY_39 },
  ],
  shown: 3,
  total: 3,
}

function offsetHours(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * 60 * 60_000).toISOString()
}

// Any other registered repository id gets an empty, ok result.
export function fixtureBacklog(now: Date, repoId: RepoId): BacklogResponse {
  if (repoId !== WIDGETS_ID) {
    return { ok: true, items: [], scanned: 0, total: 0, viewer: VIEWER, fetchedAt: now.toISOString() }
  }
  const items: readonly BacklogItem[] = [
    {
      number: 47,
      title: 'Add dark mode to the email templates',
      url: 'https://github.com/acme/widgets/issues/47',
      updatedAt: offsetHours(now, 3),
      assignees: [],
      labels: [
        { name: 'enhancement', color: 'a2eeef' },
        { name: 'design', color: '5319e7' },
      ],
      subIssueCount: 0,
      blockers: UNBLOCKED,
      blocking: UNBLOCKED,
      parent: NO_PARENT,
      children: NO_CHILDREN,
    },
    {
      number: 45,
      title: 'Document the webhook retry policy',
      url: 'https://github.com/acme/widgets/issues/45',
      updatedAt: offsetHours(now, 24),
      assignees: ['alice'],
      labels: [{ name: 'documentation', color: '0075ca' }],
      subIssueCount: 0,
      blockers: BLOCKED_BY_43,
      blocking: UNBLOCKED,
      parent: NO_PARENT,
      children: NO_CHILDREN,
    },
    {
      number: 43,
      title: 'Rate-limit the public search endpoint',
      url: 'https://github.com/acme/widgets/issues/43',
      updatedAt: offsetHours(now, 96),
      assignees: [],
      labels: [],
      subIssueCount: 0,
      blockers: UNBLOCKED,
      blocking: BLOCKING_45,
      parent: { ok: true, parent: { number: 41, title: 'Overhaul the notification settings', state: 'OPEN' } },
      children: NO_CHILDREN,
    },
    {
      number: 41,
      title: 'Overhaul the notification settings',
      url: 'https://github.com/acme/widgets/issues/41',
      updatedAt: offsetHours(now, 120),
      assignees: [],
      labels: [
        { name: 'epic', color: '3e4b9e' },
        { name: 'settings', color: 'fbca04' },
        { name: 'needs-triage', color: null },
      ],
      subIssueCount: 3,
      blockers: UNBLOCKED,
      blocking: UNBLOCKED,
      parent: NO_PARENT,
      children: EPIC_41_CHILDREN,
    },
  ]
  return { ok: true, items, scanned: 4, total: 4, viewer: VIEWER, fetchedAt: now.toISOString() }
}
