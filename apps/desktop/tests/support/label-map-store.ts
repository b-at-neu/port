import { ticketOfKeys } from '@/main/pipeline/state/migrate'
import { legacyKeysOf } from '@/main/pipeline/state/mirror'
import { applyEvent } from '@/main/pipeline/transitions'
import type { WriteEventParams, WriteOutcome } from '@/types/writes'
import type { LabelKey } from '@/utils/labels/vocabulary'
import type { Ticket } from '@/utils/pipeline/ticket'
import type { RepoId } from '@/utils/repos'

type LabelMap = Map<number, Set<LabelKey>>
type PrMap = Map<number, { closes: number; branch: string; labels: Set<LabelKey> }>

/** A fake store and "GitHub" in one: the ticket is read from label maps a test may move by hand, the real table decides, and every half it changes is recorded. */
export function labelMapStore(labels: LabelMap, prs: PrMap, repo: RepoId, at: string) {
  const labelWrites: { readonly action: string; readonly number: number }[] = []

  function ticketOf(_repoId: RepoId, kind: 'issue' | 'pull-request', number: number): Ticket | null {
    const prEntry = [...prs.entries()].find(([prNumber, pr]) => (kind === 'pull-request' ? prNumber === number : pr.closes === number))
    const issueNumber = kind === 'issue' ? number : (prEntry?.[1].closes ?? null)
    const issueSet = issueNumber === null ? undefined : labels.get(issueNumber)
    if (issueNumber === null || (issueSet === undefined && prEntry === undefined)) return null
    const pr = prEntry === undefined ? null : { number: prEntry[0], keys: [...prEntry[1].labels], approvedAt: null }
    return ticketOfKeys({ repo, ticket: issueNumber, issueKeys: [...(issueSet ?? [])], pr, history: [], at, mirrorFailure: null, reviewCycles: 0, stageHint: null }).ticket
  }

  function writeEvent({ request }: WriteEventParams): Promise<WriteOutcome> {
    const ticket = ticketOf(request.repoId, request.kind, request.number)
    if (ticket === null) return Promise.resolve({ kind: 'item-unavailable' })
    const result = applyEvent(ticket, request.event, { at, actor: null, repo: request.repoId, ref: { kind: request.kind, number: request.number } })
    if (!result.ok) return Promise.resolve({ kind: 'precondition-failed', conflict: { kind: 'precondition-failed', expected: [], observed: [], readAt: at } })
    const prNumber = result.ticket.pr?.number
    const halves = [
      { set: labels.get(result.ticket.ticket), keys: legacyKeysOf(result.ticket, 'issue'), number: result.ticket.ticket, kind: 'issue' },
      { set: prNumber === undefined ? undefined : prs.get(prNumber)?.labels, keys: legacyKeysOf(result.ticket, 'pull-request'), number: prNumber ?? 0, kind: 'pull-request' },
    ]
    for (const half of request.kind === 'issue' ? halves : halves.reverse()) {
      if (half.set === undefined || half.keys === null) continue
      half.set.clear()
      for (const key of half.keys) half.set.add(key)
      labelWrites.push({ action: request.action, number: half.number })
    }
    return Promise.resolve({ kind: 'applied', argv: [] })
  }

  return { ticketOf, writeEvent, labelWrites }
}
