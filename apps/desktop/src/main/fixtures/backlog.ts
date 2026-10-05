// Fixture mode's own canned backlog: one populated scenario for `acme/widgets`.
import type { BacklogResponse } from '../../shared/backlog/types'
import type { RepoId } from '../../shared/repos'
import { WIDGETS_ID } from './repos'

const VIEWER = 'octo-dev'

function offsetHours(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * 60 * 60_000).toISOString()
}

// Any other registered repository id gets an empty, ok result.
export function fixtureBacklog(now: Date, repoId: RepoId): BacklogResponse {
  if (repoId !== WIDGETS_ID) {
    return { ok: true, items: [], scanned: 0, total: 0, viewer: VIEWER, fetchedAt: now.toISOString() }
  }
  return {
    ok: true,
    items: [
      { number: 47, title: 'Add dark mode to the email templates', url: 'https://github.com/acme/widgets/issues/47', updatedAt: offsetHours(now, 3), assignees: [] },
      { number: 45, title: 'Document the webhook retry policy', url: 'https://github.com/acme/widgets/issues/45', updatedAt: offsetHours(now, 24), assignees: ['alice'] },
      { number: 43, title: 'Rate-limit the public search endpoint', url: 'https://github.com/acme/widgets/issues/43', updatedAt: offsetHours(now, 96), assignees: [] },
    ],
    scanned: 3,
    total: 3,
    viewer: VIEWER,
    fetchedAt: now.toISOString(),
  }
}
