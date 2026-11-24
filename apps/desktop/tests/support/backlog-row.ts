import type { BacklogChild, BacklogRowView, ChildBlockerRead, ChildrenRead, ParentRead } from '@/types/backlog'
import type { BlockerRead } from '@/types/github'
import type { RepoId } from '@/utils/repos'

export const BACKLOG_REPO_ID = 'repo-a' as RepoId

const NO_LINKS: BlockerRead = { ok: true, open: [], shown: 0, total: 0 }
const CHILD_NO_LINKS: ChildBlockerRead = { ok: true, open: [], closed: [], shown: 0, total: 0 }
const NO_PARENT: ParentRead = { ok: true, parent: null }
const NO_CHILDREN: ChildrenRead = { ok: true, children: [], shown: 0, total: 0 }

export function blockedBy(...numbers: number[]): ChildBlockerRead {
  return { ok: true, open: numbers.map((number) => ({ number, title: `#${number}`, url: `u${number}`, state: 'OPEN' })), closed: [], shown: numbers.length, total: numbers.length }
}

export function closedBlockedBy(...numbers: number[]): ChildBlockerRead {
  return { ok: true, open: [], closed: numbers.map((number) => ({ number, title: `#${number}`, url: `u${number}`, state: 'CLOSED' })), shown: numbers.length, total: numbers.length }
}

export function child(number: number, overrides: Partial<BacklogChild> = {}): BacklogChild {
  return { number, title: `Child ${number}`, state: 'OPEN', claimed: false, blockers: CHILD_NO_LINKS, ...overrides }
}

export function backlogRow(number: number, overrides: Partial<BacklogRowView> = {}): BacklogRowView {
  return {
    repoId: BACKLOG_REPO_ID,
    repo: 'acme/widgets',
    number,
    title: `Ticket ${number}`,
    url: `u${number}`,
    assignee: null,
    createdAt: '2026-01-01T00:00:00Z',
    labels: [],
    subIssueCount: 0,
    blockers: NO_LINKS,
    blocking: NO_LINKS,
    parent: NO_PARENT,
    children: NO_CHILDREN,
    ...overrides,
  }
}

export function epicRow(number: number, children: readonly BacklogChild[], overrides: Partial<BacklogRowView> = {}): BacklogRowView {
  return backlogRow(number, { subIssueCount: children.length, children: { ok: true, children, shown: children.length, total: children.length }, ...overrides })
}

export function memberRow(number: number, epic: number, overrides: Partial<BacklogRowView> = {}): BacklogRowView {
  return backlogRow(number, { parent: { ok: true, parent: { number: epic, title: `Epic ${epic}`, state: 'OPEN' } }, ...overrides })
}
