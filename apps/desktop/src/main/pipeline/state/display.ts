// Pure: the display labels a ticket shows, a function of the ticket alone.
import type { DisplayKey } from '@/utils/labels/display'
import type { Stage, Ticket } from '@/utils/pipeline/ticket'

const STAGE_LABEL: Readonly<Record<Stage, DisplayKey>> = {
  plan: 'planning',
  implement: 'implementing',
  review: 'reviewing',
  revise: 'revising',
  refresh: 'revising',
  merge: 'approved',
}

export function displayOf(ticket: Pick<Ticket, 'stage' | 'status'>): readonly DisplayKey[] {
  const { stage, status } = ticket
  if (status.kind === 'held') return ['port']
  if (status.kind === 'done') return ['port', 'approved']
  const needsYou = status.kind === 'blocked' || (status.kind === 'waiting-on-you' && status.gate !== 'merge')
  return needsYou ? ['port', STAGE_LABEL[stage], 'needsYou'] : ['port', STAGE_LABEL[stage]]
}
