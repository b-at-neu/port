import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { ReconciledItem } from '@/types/state'
import { prSuffixOf, ticketIndex, ticketLabel, ticketLabelFor } from '@/utils/tickets/ticket'

const LABELLED = { stage: 'trigger', stages: [{ key: 'ready', name: 'ready', role: 'trigger' }] } as const

function issue(number: number, overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return { repoId: 'repo-a' as RepoId, repo: 'o/a', kind: 'issue', number, title: `issue ${String(number)}`, url: `https://github.com/o/a/issues/${String(number)}`, stage: null, stages: [], linked: null, ...overrides } as unknown as ReconciledItem
}

function pullRequest(number: number, overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return { ...issue(number), kind: 'pull-request', title: `pr ${String(number)}`, url: `https://github.com/o/a/pull/${String(number)}`, ...overrides } as unknown as ReconciledItem
}

describe('ticketIndex', () => {
  it('folds an issue and its linked pull request into one ticket, reachable by both numbers', () => {
    const index = ticketIndex([issue(464, { linked: 537 }), pullRequest(537, { linked: 464 })])
    expect(index.tickets).toHaveLength(1)
    const ticket = index.byNumber.get(537)
    expect(ticket).toBe(index.byNumber.get(464))
    expect(ticket?.ref).toEqual({ kind: 'issue', number: 464, title: 'issue 464', url: 'https://github.com/o/a/issues/464', pullRequest: { number: 537, url: 'https://github.com/o/a/pull/537' } })
    expect(ticket?.issue?.number).toBe(464)
    expect(ticket?.pullRequest?.number).toBe(537)
  })

  it('keeps an issue with no linked pull request as its own ticket', () => {
    const [ticket] = ticketIndex([issue(7)]).tickets
    expect(ticket?.ref).toMatchObject({ kind: 'issue', number: 7, pullRequest: null })
    expect(ticket?.pullRequest).toBeNull()
    expect(ticket?.primary.number).toBe(7)
  })

  it('keys a pull request with no linked issue as an unlinked-pr ticket of its own', () => {
    const [ticket] = ticketIndex([pullRequest(35)]).tickets
    expect(ticket?.ref).toEqual({ kind: 'unlinked-pr', number: 35, title: 'pr 35', url: 'https://github.com/o/a/pull/35' })
    expect(ticket?.issue).toBeNull()
  })

  it("keys a pull request whose linked issue is outside the sweep by that issue's number, with the pull request's title", () => {
    const index = ticketIndex([pullRequest(537, { linked: 464 })])
    const [ticket] = index.tickets
    expect(ticket?.ref).toMatchObject({ kind: 'issue', number: 464, title: 'pr 537', pullRequest: { number: 537 } })
    expect(ticket?.issue).toBeNull()
    expect(index.byNumber.get(537)).toBe(ticket)
    expect(index.byNumber.get(464)).toBe(ticket)
  })

  it("folds only the pull request the issue's own link names; a second pull request closing the same issue keeps its own row", () => {
    const index = ticketIndex([issue(464, { linked: 537 }), pullRequest(537, { linked: 464 }), pullRequest(540, { linked: 464 })])
    expect(index.tickets.map((t) => t.ref.number)).toEqual([464, 540])
    expect(index.byNumber.get(540)?.ref.kind).toBe('unlinked-pr')
    expect(index.byNumber.get(464)?.pullRequest?.number).toBe(537)
  })

  it('keeps a pull request whose linked issue is in the sweep but links elsewhere as a separate ticket, never colliding on the issue number', () => {
    const index = ticketIndex([issue(464), pullRequest(540, { linked: 464 })])
    expect(index.tickets).toHaveLength(2)
    expect(index.byNumber.get(464)?.issue?.number).toBe(464)
    expect(index.byNumber.get(540)?.ref.number).toBe(540)
  })

  describe('primary', () => {
    it('is the pull request when it carries a stage label', () => {
      const [ticket] = ticketIndex([issue(1, { linked: 2, ...LABELLED }), pullRequest(2, { linked: 1, ...LABELLED })]).tickets
      expect(ticket?.primary.number).toBe(2)
    })

    it('is the pull request when the issue has lost its stage label', () => {
      const [ticket] = ticketIndex([issue(1, { linked: 2 }), pullRequest(2, { linked: 1, ...LABELLED })]).tickets
      expect(ticket?.primary.number).toBe(2)
    })

    it('is the issue when only the issue carries a stage label', () => {
      const [ticket] = ticketIndex([issue(1, { linked: 2, ...LABELLED }), pullRequest(2, { linked: 1 })]).tickets
      expect(ticket?.primary.number).toBe(1)
    })

    it('is the stranded pull request when neither carries a stage label, so the status stays Unstaged', () => {
      const [ticket] = ticketIndex([issue(1, { linked: 2 }), pullRequest(2, { linked: 1 })]).tickets
      expect(ticket?.primary.number).toBe(2)
      expect(ticket?.primary.stage).toBeNull()
    })
  })
})

describe('ticketLabel / prSuffixOf / ticketLabelFor', () => {
  const index = ticketIndex([issue(464, { linked: 537 }), pullRequest(537, { linked: 464 }), pullRequest(35)])

  it('labels an issue ticket `#n title` with a `(PR#n)` suffix, and an unlinked pull request `PR#n title` with none', () => {
    const linked = index.byNumber.get(464)
    const bare = index.byNumber.get(35)
    expect(linked !== undefined && ticketLabel(linked.ref)).toBe('#464 issue 464')
    expect(linked !== undefined && prSuffixOf(linked.ref)).toBe('(PR#537)')
    expect(bare !== undefined && ticketLabel(bare.ref)).toBe('PR#35 pr 35')
    expect(bare !== undefined && prSuffixOf(bare.ref)).toBeNull()
  })

  it('resolves a pull request number to its issue ticket, and falls back to a bare number outside the sweep', () => {
    expect(ticketLabelFor(index, 537, 'pull-request')).toBe('#464 issue 464')
    expect(ticketLabelFor(index, 999, 'issue')).toBe('#999')
    expect(ticketLabelFor(index, 998, 'pull-request')).toBe('PR#998')
  })
})
