// Pure: the ticket a first sighting of an item seeds, read from the display labels it wears. A display label says what the ticket shows, not its history, so the seed is coarse by design.
import type { PipelineItemKind } from '@/types/github'
import type { DisplayKey } from '@/utils/labels/display'
import type { Stage, Status, Ticket } from '@/utils/pipeline/ticket'
import type { RepoId } from '@/utils/repos'

const IN_FLIGHT: readonly { readonly key: DisplayKey; readonly stage: Stage }[] = [
  { key: 'planning', stage: 'plan' },
  { key: 'implementing', stage: 'implement' },
  { key: 'reviewing', stage: 'review' },
  { key: 'revising', stage: 'revise' },
]

export interface TicketOfDisplayParams {
  readonly repo: RepoId
  readonly ticket: number
  readonly kind: PipelineItemKind
  readonly keys: readonly DisplayKey[]
  readonly pr: { readonly number: number } | null
  readonly at: string
}

/** `null` for an item that does not wear the `port` marker: it is not in the pipeline. */
export function ticketOfDisplay(params: TicketOfDisplayParams): Ticket | null {
  const { keys, kind, pr } = params
  if (!keys.includes('port')) return null
  const inFlight = IN_FLIGHT.find((candidate) => keys.includes(candidate.key))
  const fallback: Stage = kind === 'pull-request' || pr !== null ? 'review' : 'plan'
  const [stage, status]: [Stage, Status] = (() => {
    if (keys.includes('needsYou')) return [inFlight?.stage ?? fallback, { kind: 'waiting-on-you', gate: 'escalation', detail: '' }]
    if (inFlight !== undefined) return [inFlight.stage, { kind: 'running', runId: null }]
    if (keys.includes('approved')) return ['merge', { kind: 'waiting-on-you', gate: 'merge', detail: '' }]
    return [fallback, { kind: 'held', on: 'paused', detail: 'stopped' }]
  })()
  return {
    rev: 0,
    repo: params.repo,
    ticket: params.ticket,
    pr: pr === null ? null : { number: pr.number, approvedAt: keys.includes('approved') ? params.at : null },
    stage,
    status,
    autoPlan: false,
    reviewCycles: 0,
    runs: [],
    history: [],
    mirror: { written: [], failure: null },
  }
}
