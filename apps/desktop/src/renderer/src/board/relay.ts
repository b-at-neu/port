// The relay loop's own header line (#107) — the banner, compose form and
// per-pending expand/answer state moved to the Needs you screen (#315,
// `needs-you/relay-form.tsx`); this module keeps only the board header's own
// "nothing waiting"/"N waiting" line, since that still reads the scan
// directly rather than going through `needsYouItems`.
import type { RelayScan } from '../../../shared/relay/types'

/** The header line — never `''`. A zero-checked scan (a ready repository
 *  with no dispatched stage agents at all) is written out the same as any
 *  other "nothing waiting" case, never silence (ENGINEERING §4: an absent
 *  signal is never read as a passing one). Only the caller (`view.ts`)
 *  withholds the line entirely, before the first snapshot lands. */
export function relayLineCopy(scan: RelayScan): string {
  if (!scan.ok) return "Relay: can't read agent transcripts, so a waiting agent would be invisible here."

  const { pending, checked, unreached } = scan
  if (pending.length > 0) return `Relay: ${String(pending.length)} waiting on you.`
  if (unreached > 0) {
    return `Relay: nothing waiting (${String(checked)} checked, ${String(unreached)} transcript${unreached === 1 ? '' : 's'} unreadable — can't tell whether it's waiting).`
  }
  return `Relay: nothing waiting (${String(checked)} agent${checked === 1 ? '' : 's'} checked).`
}
