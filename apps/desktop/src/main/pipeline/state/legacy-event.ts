// Pure: the label-keyed half of the transition table. The `labels` event survives only for claim/index, the untracked-PR gate marker and adopt's existing path.
import { ticketOfKeys } from '@/main/pipeline/state/migrate'
import { legacyKeysOf } from '@/main/pipeline/state/mirror'
import type { StateEvent } from '@/types/stage-labels'
import type { TicketRef } from '@/types/pipeline-state'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { Ticket } from '@/utils/pipeline/ticket'
import type { RepoId } from '@/utils/repos'

type LabelsEvent = Extract<StateEvent, { kind: 'labels' }>

interface LabelsContext {
  readonly at: string
  readonly repo: RepoId
  readonly ref: TicketRef
}

/** Every key either half of the ticket carries, each prefixed with its half's kind. */
export function prefixedKeys(ticket: Ticket): Set<string> {
  const halves = (['issue', 'pull-request'] as const).flatMap((kind) => (legacyKeysOf(ticket, kind) ?? []).map((key) => `${kind}:${key}`))
  return new Set(halves)
}

/** The keys a change added and removed across both halves, `null` when it touched none. */
export function legacyDiffOf(before: Ticket | null, after: Ticket): { readonly add: string[]; readonly remove: string[] } | null {
  const was = before === null ? new Set<string>() : prefixedKeys(before)
  const now = prefixedKeys(after)
  const add = [...now].filter((key) => !was.has(key))
  const remove = [...was].filter((key) => !now.has(key))
  return add.length === 0 && remove.length === 0 ? null : { add, remove }
}

export type LabelsResult = { readonly kind: 'moved' } | { readonly kind: 'unchanged' } | { readonly kind: 'next'; readonly ticket: Ticket }

/** The ticket a label request makes of the current one, re-derived from the keys; `ticket` is `null` for a first sighting. */
export function applyLabels(ticket: Ticket | null, event: LabelsEvent, ctx: LabelsContext): LabelsResult {
  const { itemKind } = event
  const current = ticket === null ? [] : (legacyKeysOf(ticket, itemKind) ?? [])
  if (!event.expect.present.every((key) => current.includes(key)) || event.expect.absent.some((key) => current.includes(key))) return { kind: 'moved' }
  const keys: LabelKey[] = current.filter((key) => !event.remove.includes(key))
  for (const key of event.add) if (!keys.includes(key)) keys.push(key)

  const otherKind = itemKind === 'issue' ? 'pull-request' : 'issue'
  const other = ticket === null ? null : legacyKeysOf(ticket, otherKind)
  const issueKeys = itemKind === 'issue' ? keys : (other ?? [])
  const prNumber = itemKind === 'pull-request' ? ctx.ref.number : (ticket?.pr?.number ?? null)
  const prKeys = itemKind === 'pull-request' ? keys : other
  const resolved = ticketOfKeys({
    repo: ctx.repo,
    ticket: ticket?.ticket ?? (itemKind === 'issue' ? ctx.ref.number : (event.issue ?? ctx.ref.number)),
    issueKeys,
    pr: prNumber === null ? null : { number: prNumber, keys: prKeys ?? [], approvedAt: ticket?.pr?.number === prNumber ? ticket.pr.approvedAt : null },
    history: ticket?.history ?? [],
    at: ctx.at,
    mirrorFailure: ticket?.mirror.failure ?? null,
    reviewCycles: ticket?.reviewCycles ?? 0,
    stageHint: ticket?.stage ?? null,
  }).ticket
  if (ticket === null) return { kind: 'next', ticket: resolved }
  const next: Ticket = { ...ticket, stage: resolved.stage, status: resolved.status, pr: resolved.pr, autoPlan: resolved.autoPlan }
  return legacyDiffOf(ticket, next) === null ? { kind: 'unchanged' } : { kind: 'next', ticket: next }
}
