// The one "held on" derivation: the row tag, the Blocked section and the item pane all read `row.blockedOn`, never a second one.
import type { BlockedOn, BlockedOnTag } from '@/types/board'
import type { HostedSessionSnapshot } from '@/types/hosting'
import type { IssueCommentNode } from '@/types/github'
import type { ReconciledItem } from '@/types/state'
import type { Ticket } from '@/types/ticket'
import type { RepoId } from '@/utils/repos'
import { isLiveStageSession } from '@/utils/stage/live'
import { blockedReasonOf, capHandbackText, classifyHandbackText } from '@/utils/stage/handback-text'

interface BlockedOnParams {
  readonly ticket: Ticket
  readonly stageKey: string | undefined
  readonly sessions: readonly HostedSessionSnapshot[]
  readonly repoId: RepoId
}

/** The newest live stage session on any ticket member whose last hand-back is a `BLOCKED:` line. */
function sessionReasonOf(members: readonly ReconciledItem[], sessions: readonly HostedSessionSnapshot[], repoId: RepoId): BlockedOn['session'] {
  const numbers = new Set(members.map((member) => member.number))
  let newest: { readonly startedAt: number; readonly text: string; readonly sessionKey: HostedSessionSnapshot['sessionKey'] } | null = null
  for (const session of sessions) {
    if (session.stage === null || session.repoId !== repoId || !numbers.has(session.stage.number) || !isLiveStageSession(session)) continue
    if (session.lastResult === null || session.lastResult.isError) continue
    const handback = classifyHandbackText(session.lastResult.text ?? '')
    if (handback?.kind !== 'blocked') continue
    const startedAt = Date.parse(session.startedAt)
    if (newest === null || startedAt > newest.startedAt) newest = { startedAt, text: blockedReasonOf(handback.line), sessionKey: session.sessionKey }
  }
  return newest === null ? null : { text: newest.text, sessionKey: newest.sessionKey }
}

function firstTextLine(body: string): string | null {
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '' && !trimmed.startsWith('#')) return capHandbackText(trimmed)
  }
  return null
}

/** The newest issue comment at or before the latest `blocked` label event — no event means no comment, never an unrelated one. */
function commentReasonOf(issue: ReconciledItem | null): BlockedOn['comment'] {
  const blockedAt = issue?.stageHistory.filter((entry) => entry.key === 'blocked').map((entry) => Date.parse(entry.at)).sort((a, b) => b - a)[0]
  if (issue === null || blockedAt === undefined || issue.blockerComments === null) return null
  let picked: { readonly node: IssueCommentNode; readonly at: number } | null = null
  for (const node of issue.blockerComments) {
    const at = Date.parse(node.createdAt)
    if (Number.isNaN(at) || at > blockedAt) continue
    if (picked === null || at > picked.at) picked = { node, at }
  }
  if (picked === null) return null
  const text = firstTextLine(picked.node.body)
  return text === null ? null : { text, url: picked.node.url }
}

/** `null` unless the stage is `blocked` or a live session's hand-back says `BLOCKED:` — open `blockedBy` links alone never make a ticket blocked. */
export function blockedOnOf(params: BlockedOnParams): BlockedOn | null {
  const members = [params.ticket.issue, params.ticket.pullRequest].filter((member): member is ReconciledItem => member !== null)
  const session = sessionReasonOf(members, params.sessions, params.repoId)
  if (params.stageKey !== 'blocked' && session === null) return null
  return { dependencies: params.ticket.issue?.blockers ?? null, session, comment: commentReasonOf(params.ticket.issue) }
}

/** The most specific thing a row is held on: an open dependency, then the agent's reason, the ticket's comment, an unreadable dependency read, a fallback. */
export function blockedOnTag(blockedOn: BlockedOn): BlockedOnTag {
  const { dependencies, session, comment } = blockedOn
  if (dependencies?.ok === true && dependencies.open.length > 0) return { kind: 'dependency', open: dependencies.open, shown: dependencies.shown, total: dependencies.total }
  if (session !== null) return { kind: 'session', text: session.text }
  if (comment !== null) return { kind: 'comment', text: comment.text }
  if (dependencies?.ok === false) return { kind: 'unreadable', reason: dependencies.reason }
  return { kind: 'fallback' }
}
