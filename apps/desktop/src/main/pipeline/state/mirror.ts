// Pure: the halves a ticket tracks and the label names GitHub should show for it. Nothing here reads a label or touches I/O.
import type { PipelineItemKind } from '@/types/github'
import type { TicketRef, TrackedItem } from '@/types/pipeline-state'
import type { DisplayKey, DisplayVocabulary } from '@/utils/labels/display'
import type { Ticket } from '@/utils/pipeline/ticket'

function numberOf(ticket: Ticket, kind: PipelineItemKind): number | null {
  return kind === 'issue' ? ticket.ticket : (ticket.pr?.number ?? null)
}

/** The tracked halves of a ticket, issue first; a ticket whose pull request is its own number has no issue half. */
export function halvesOf(ticket: Ticket): TicketRef[] {
  return (['issue', 'pull-request'] as const).flatMap((kind) => {
    const number = numberOf(ticket, kind)
    return number === null || (kind === 'issue' && ticket.pr?.number === ticket.ticket) ? [] : [{ kind, number }]
  })
}

/** One entry per tracked half. */
export function itemsOf(ticket: Ticket): TrackedItem[] {
  return halvesOf(ticket).map((half) => ({ ...half, ticket }))
}

/** The ticket number a `<n>-…` branch names, `null` for any other branch. */
export function issueNumberOfBranch(headRefName: string | null): number | null {
  const match = /^(\d+)-/.exec(headRefName ?? '')
  return match === null ? null : Number(match[1])
}

export function displayNamesOf(vocabulary: DisplayVocabulary, keys: readonly DisplayKey[]): readonly string[] {
  return keys.flatMap((key) => vocabulary.labels.find((label) => label.key === key)?.name ?? [])
}

/** `desired` is what the ticket shows; `all` is every display name, so a stale one on the item cleans itself up. */
export function mirrorNamesOf(display: readonly DisplayKey[], vocabulary: DisplayVocabulary): { readonly desired: readonly string[]; readonly all: readonly string[] } {
  return { desired: displayNamesOf(vocabulary, display), all: vocabulary.labels.map((label) => label.name) }
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
