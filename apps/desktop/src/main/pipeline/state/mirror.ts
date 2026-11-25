// Pure: the legacy projection of a ticket and the label names GitHub should show for it. Nothing here reads a label or touches I/O.
import type { PipelineItemKind } from '@/types/github'
import type { StoredHistoryRow, StoredItem, TicketRef } from '@/types/pipeline-state'
import type { DisplayKey, DisplayVocabulary } from '@/utils/labels/display'
import { LABEL_KEYS, labelName, type LabelKey, type LabelVocabulary } from '@/utils/labels/vocabulary'
import type { Stage, Ticket } from '@/utils/pipeline/ticket'

const KEYS: ReadonlySet<string> = new Set(LABEL_KEYS)

function isKey(value: string): value is LabelKey {
  return KEYS.has(value)
}

const QUEUED_KEY: Readonly<Record<Stage, LabelKey | null>> = { plan: 'ready', implement: 'planApproved', review: 'readyForReview', revise: 'needsRevision', refresh: 'refreshBranch', merge: null }
const RUNNING_KEY: Readonly<Record<Stage, LabelKey | null>> = { plan: 'planning', implement: 'inProgress', review: 'reviewing', revise: 'revising', refresh: 'refreshing', merge: null }

/** The stage key a ticket's stage and status stand for, `null` for a status no label ever carried. */
export function stateKeyOf(ticket: Pick<Ticket, 'stage' | 'status'>): LabelKey | null {
  const { stage, status } = ticket
  switch (status.kind) {
    case 'queued':
      return stage === 'plan' && status.reason === 'changes-requested' ? 'planChangesRequested' : QUEUED_KEY[stage]
    case 'running':
      return RUNNING_KEY[stage]
    case 'waiting-on-you':
      if (status.gate === 'plan-approval') return 'planReview'
      return status.gate === 'merge' ? 'approved' : 'needsHuman'
    case 'blocked':
      return 'blocked'
    case 'held':
      return null
    case 'done':
      return 'approved'
  }
}

/** The label keys one half of a ticket carries, markers included; `null` when that half is not tracked. */
export function legacyKeysOf(ticket: Ticket, kind: PipelineItemKind): readonly LabelKey[] | null {
  const marker: readonly LabelKey[] = ['marker']
  if (kind === 'issue') {
    if (ticket.pr?.number === ticket.ticket) return null
    return [...marker, ...(ticket.autoPlan ? (['autoPlan'] as const) : []), ...(ticket.pr !== null ? (['prOpened'] as const) : stateKeyOrNothing(ticket))]
  }
  if (ticket.pr === null) return null
  return [...marker, ...stateKeyOrNothing(ticket), ...(ticket.pr.approvedAt !== null && ticket.stage === 'refresh' ? (['approved'] as const) : [])]
}

function stateKeyOrNothing(ticket: Ticket): readonly LabelKey[] {
  const key = stateKeyOf(ticket)
  return key === null ? [] : [key]
}

function numberOf(ticket: Ticket, kind: PipelineItemKind): number | null {
  return kind === 'issue' ? ticket.ticket : (ticket.pr?.number ?? null)
}

/** The tracked halves of a ticket, issue first. */
export function halvesOf(ticket: Ticket): TicketRef[] {
  return (['issue', 'pull-request'] as const).flatMap((kind) => {
    const number = numberOf(ticket, kind)
    return legacyKeysOf(ticket, kind) === null || number === null ? [] : [{ kind, number }]
  })
}

function rowsOf(ticket: Ticket, kind: PipelineItemKind): StoredHistoryRow[] {
  const prefix = `${kind}:`
  const keysOf = (entries: readonly string[]): LabelKey[] => entries.filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length)).filter(isKey)
  return ticket.history.flatMap((event) => {
    if (event.legacy === null) return []
    const add = keysOf(event.legacy.add)
    const remove = keysOf(event.legacy.remove)
    return add.length === 0 && remove.length === 0 ? [] : [{ at: event.at, action: event.action, add, remove, actor: event.actor }]
  })
}

/** The legacy per-item shape the readers still consume: one entry per tracked half. */
export function itemsOf(ticket: Ticket): StoredItem[] {
  const updatedAt = ticket.history.at(-1)?.at ?? ticket.mirror.failure?.at ?? ''
  const claimedAt = ticket.history.findLast((event) => event.to?.status === 'running')?.at ?? null
  return (['issue', 'pull-request'] as const).flatMap((kind): StoredItem[] => {
    const keys = legacyKeysOf(ticket, kind)
    const number = numberOf(ticket, kind)
    if (keys === null || number === null) return []
    return [
      {
        kind,
        number,
        keys: keys.filter((key) => key !== 'marker' && key !== 'autoPlan'),
        marked: keys.includes('marker'),
        autoPlan: keys.includes('autoPlan'),
        claimedAt,
        reviewCycles: ticket.reviewCycles,
        history: rowsOf(ticket, kind),
        updatedAt,
        issue: kind === 'pull-request' && ticket.pr?.number !== ticket.ticket ? ticket.ticket : null,
        mirrorFailure: ticket.mirror.failure,
      },
    ]
  })
}

/** The ticket number a `<n>-…` branch names, `null` for any other branch. */
export function issueNumberOfBranch(headRefName: string | null): number | null {
  const match = /^(\d+)-/.exec(headRefName ?? '')
  return match === null ? null : Number(match[1])
}

export function displayNamesOf(vocabulary: DisplayVocabulary, keys: readonly DisplayKey[]): readonly string[] {
  return keys.flatMap((key) => vocabulary.labels.find((label) => label.key === key)?.name ?? [])
}

export function legacyNamesOf(vocabulary: LabelVocabulary, keys: readonly LabelKey[]): readonly string[] {
  return keys.flatMap((key) => labelName(vocabulary, key) ?? [])
}

/** `desired` is what the ticket shows; `all` adds every legacy-vocabulary name, so an old label on the item cleans itself up. */
export function mirrorNamesOf(display: readonly DisplayKey[], vocabulary: DisplayVocabulary, legacy: LabelVocabulary): { readonly desired: readonly string[]; readonly all: readonly string[] } {
  return { desired: displayNamesOf(vocabulary, display), all: [...vocabulary.labels.map((label) => label.name), ...legacy.labels.map((label) => label.name)] }
}

/** Adds the desired names the item lacks and removes every other vocabulary name it carries; a name outside `all` is never touched. */
export function mirrorDiff(desired: readonly string[], all: readonly string[], observed: readonly string[]): { readonly addNames: readonly string[]; readonly removeNames: readonly string[] } {
  const lower = (name: string): string => name.toLowerCase()
  const present = new Set(observed.map(lower))
  const wanted = new Set(desired.map(lower))
  const addNames = desired.filter((name, index) => !present.has(lower(name)) && desired.findIndex((other) => lower(other) === lower(name)) === index)
  const removeNames = all.filter((name, index) => !wanted.has(lower(name)) && present.has(lower(name)) && all.findIndex((other) => lower(other) === lower(name)) === index)
  return { addNames, removeNames }
}
