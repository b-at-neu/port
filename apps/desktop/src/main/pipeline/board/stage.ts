import type { Ticket } from '@/utils/pipeline/ticket'

/** What a ticket's status stands for in the item-status ladder. */
export type StageRole = 'trigger' | 'in-flight' | 'gate' | 'terminal'

/** The role a ticket's own status stands for: running is in flight, queued and held are a trigger, waiting and blocked are a gate. */
export function roleOfTicket(ticket: Pick<Ticket, 'status'>): StageRole {
  switch (ticket.status.kind) {
    case 'running':
      return 'in-flight'
    case 'queued':
    case 'held':
      return 'trigger'
    case 'waiting-on-you':
    case 'blocked':
      return 'gate'
    case 'done':
      return 'terminal'
  }
}
