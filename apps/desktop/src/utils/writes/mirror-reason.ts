import type { WriteOutcome } from '@/types/writes'

/** Why a write did not land, as a clause that follows "—": the shared reason behind every mirror-failed line. */
export function mirrorReason(outcome: WriteOutcome): string {
  switch (outcome.kind) {
    case 'write-failed':
      return outcome.stderr.split('\n')[0] ?? ''
    case 'verify-failed':
    case 'state-unsaved':
    case 'ownership-unreadable':
      return outcome.message
    case 'item-unavailable':
      return 'the item is no longer available'
    case 'precondition-failed':
      return 'the labels on GitHub changed'
    case 'terminal-owned':
      return 'a terminal cockpit owns this repository'
    case 'unresolvable-label':
      return `no label is configured for ${outcome.keys.join(', ')}`
    case 'mirror-failed':
      return mirrorReason(outcome.mirror)
    case 'applied':
    case 'no-op':
      return ''
  }
}
