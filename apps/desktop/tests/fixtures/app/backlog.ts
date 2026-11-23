// Fixture mode's own canned backlog: one populated scenario for `acme/widgets`.
import type { BacklogItem, BacklogResponse, ChildBlockerRead, ChildrenRead, ParentRead } from '@/types/backlog'
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

const CHILD_UNBLOCKED: ChildBlockerRead = { ok: true, open: [], closed: [], shown: 0, total: 0 }

const CHILD_BLOCKED_BY_CLOSED_38: ChildBlockerRead = {
  ok: true,
  open: [],
  closed: [{ number: 38, title: 'Audit the current notification channels', url: 'https://github.com/acme/widgets/issues/38', state: 'CLOSED' }],
  shown: 1,
  total: 1,
}

const CHILD_BLOCKED_BY_39: ChildBlockerRead = {
  ok: true,
  open: [{ number: 39, title: 'Migrate stored notification preferences', url: 'https://github.com/acme/widgets/issues/39', state: 'OPEN' }],
  closed: [],
  shown: 1,
  total: 1,
}

const CHILD_BLOCKED_BY_43: ChildBlockerRead = {
  ok: true,
  open: [{ number: 43, title: 'Rate-limit the public search endpoint', url: 'https://github.com/acme/widgets/issues/43', state: 'OPEN' }],
  closed: [],
  shown: 1,
  total: 1,
}

const CHILD_BLOCKED_BY_49: ChildBlockerRead = {
  ok: true,
  open: [{ number: 49, title: 'Batch digest emails by hour', url: 'https://github.com/acme/widgets/issues/49', state: 'OPEN' }],
  closed: [],
  shown: 1,
  total: 1,
}

// The notification epic's sub-issues: one done, one claimed and blocked by the done one (Wave 2, hidden as it has nothing to list), one open and waiting on the claimed one (Wave 3), and a child epic waiting on that one (Waves 4 and 5).
const EPIC_41_CHILDREN: ChildrenRead = {
  ok: true,
  children: [
    { number: 38, title: 'Audit the current notification channels', state: 'CLOSED', claimed: false, blockers: CHILD_UNBLOCKED },
    { number: 39, title: 'Migrate stored notification preferences', state: 'OPEN', claimed: true, blockers: CHILD_BLOCKED_BY_CLOSED_38 },
    { number: 43, title: 'Rate-limit the public search endpoint', state: 'OPEN', claimed: false, blockers: CHILD_BLOCKED_BY_39 },
    { number: 48, title: 'Send notification digests', state: 'OPEN', claimed: false, blockers: CHILD_BLOCKED_BY_43 },
  ],
  shown: 4,
  total: 4,
}

const EPIC_48_CHILDREN: ChildrenRead = {
  ok: true,
  children: [
    { number: 49, title: 'Batch digest emails by hour', state: 'OPEN', claimed: false, blockers: CHILD_UNBLOCKED },
    { number: 50, title: 'Add a digest frequency setting', state: 'OPEN', claimed: false, blockers: CHILD_BLOCKED_BY_49 },
  ],
  shown: 2,
  total: 2,
}

const BLOCKED_BY_43_ONLY: BlockerRead = {
  ok: true,
  open: [{ number: 43, title: 'Rate-limit the public search endpoint', url: 'https://github.com/acme/widgets/issues/43', state: 'OPEN' }],
  shown: 1,
  total: 1,
}

const BLOCKED_BY_49: BlockerRead = {
  ok: true,
  open: [{ number: 49, title: 'Batch digest emails by hour', url: 'https://github.com/acme/widgets/issues/49', state: 'OPEN' }],
  shown: 1,
  total: 1,
}

const PARENT_41: ParentRead = { ok: true, parent: { number: 41, title: 'Overhaul the notification settings', state: 'OPEN' } }
const PARENT_48: ParentRead = { ok: true, parent: { number: 48, title: 'Send notification digests', state: 'OPEN' } }

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
      createdAt: offsetHours(now, 24 * 3),
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
      number: 41,
      title: 'Overhaul the notification settings',
      url: 'https://github.com/acme/widgets/issues/41',
      createdAt: offsetHours(now, 24 * 4),
      assignees: [],
      labels: [
        { name: 'epic', color: '3e4b9e' },
        { name: 'settings', color: 'fbca04' },
        { name: 'needs-triage', color: null },
      ],
      subIssueCount: 4,
      blockers: UNBLOCKED,
      blocking: UNBLOCKED,
      parent: NO_PARENT,
      children: EPIC_41_CHILDREN,
    },
    {
      number: 45,
      title: 'Document the webhook retry policy',
      url: 'https://github.com/acme/widgets/issues/45',
      createdAt: offsetHours(now, 24 * 6),
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
      createdAt: offsetHours(now, 24 * 9),
      assignees: [],
      labels: [],
      subIssueCount: 0,
      blockers: BLOCKED_BY_39,
      blocking: BLOCKING_45,
      parent: PARENT_41,
      children: NO_CHILDREN,
    },
    {
      number: 48,
      title: 'Send notification digests',
      url: 'https://github.com/acme/widgets/issues/48',
      createdAt: offsetHours(now, 24 * 8),
      assignees: [],
      labels: [],
      subIssueCount: 2,
      blockers: BLOCKED_BY_43_ONLY,
      blocking: UNBLOCKED,
      parent: PARENT_41,
      children: EPIC_48_CHILDREN,
    },
    {
      number: 49,
      title: 'Batch digest emails by hour',
      url: 'https://github.com/acme/widgets/issues/49',
      createdAt: offsetHours(now, 24 * 7),
      assignees: [],
      labels: [],
      subIssueCount: 0,
      blockers: UNBLOCKED,
      blocking: UNBLOCKED,
      parent: PARENT_48,
      children: NO_CHILDREN,
    },
    {
      number: 50,
      title: 'Add a digest frequency setting',
      url: 'https://github.com/acme/widgets/issues/50',
      createdAt: offsetHours(now, 24 * 5),
      assignees: [],
      labels: [],
      subIssueCount: 0,
      blockers: BLOCKED_BY_49,
      blocking: UNBLOCKED,
      parent: PARENT_48,
      children: NO_CHILDREN,
    },
  ]
  return { ok: true, items, scanned: 7, total: 7, viewer: VIEWER, fetchedAt: now.toISOString() }
}
