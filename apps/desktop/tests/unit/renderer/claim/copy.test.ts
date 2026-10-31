import { describe, expect, it } from 'vitest'
import { advisoryLine, applyResponseToast, claimedToast, dispatchLine, preflightToast, refusalCopy, takeOverPrompt, unreachableToast, writeOutcomeCopy } from '@/renderer/claim/copy'
import type { ClaimApplyResponse, ClaimVerdict } from '@/types/claim'
import type { DispatchRecord, RepoDispatchStatus } from '@/types/dispatch'
import type { WriteOutcome } from '@/types/writes'
import type { RepoId } from '@/utils/repos'

type Claimable = Extract<ClaimVerdict, { kind: 'claimable' }>

const REPO = 'acme/widgets'

function status(overrides: Partial<RepoDispatchStatus>): RepoDispatchStatus {
  return {
    repoId: 'repo-1' as RepoId,
    owner: 'app',
    state: { kind: 'idle' },
    runState: 'dispatching',
    ownedSince: null,
    unreadableMessage: null,
    budget: null,
    observed: [],
    denials: [],
    interrupted: [],
    ...overrides,
  }
}

function blocker(number: number) {
  return { number, title: `Blocker ${String(number)}`, url: `https://github.com/acme/widgets/issues/${String(number)}`, state: 'OPEN' }
}

function claimable(overrides: Partial<Claimable> = {}): Claimable {
  return { kind: 'claimable', assigneeSituation: 'unassigned', others: [], closed: false, blockers: { ok: true, open: [], shown: 0, total: 0 }, ...overrides }
}

describe('dispatchLine', () => {
  it.each([
    ['idle', { kind: 'idle' }],
    ['active', { kind: 'active', recent: [] }],
  ] as const)('an app-run repository whose dispatcher is %s starts planning now', (_name, state) => {
    expect(dispatchLine(REPO, status({ state }))).toBe('Planning starts now.')
  })

  it('says planning may not start when the last launch failed, and only then', () => {
    const record = (state: 'started' | 'failed', at: string): DispatchRecord => ({ agent: 'plan', number: 1, kind: 'issue', trigger: 'ready', state, at, detail: null, outcome: null, sessionKey: null, claudeSessionId: null, operatorJoinedAt: null })
    const failedLast = [record('started', '2026-01-01T00:00:00Z'), record('failed', '2026-01-01T00:05:00Z')]
    expect(dispatchLine(REPO, status({ state: { kind: 'active', recent: failedLast } }))).toBe('The last stage launch in acme/widgets failed, so planning may not start. Check Needs you.')
    expect(dispatchLine(REPO, status({ state: { kind: 'active', recent: [...failedLast, record('started', '2026-01-01T00:10:00Z')] } }))).toBe('Planning starts now.')
  })

  it('names the busy slots at capacity', () => {
    expect(dispatchLine(REPO, status({ state: { kind: 'at-capacity', limit: 3, waiting: 1 } }))).toBe('All 3 session slots are busy. Planning starts when one frees up.')
  })

  it('names the budget gate failure', () => {
    expect(dispatchLine(REPO, status({ state: { kind: 'budget-unavailable', message: 'script missing' } }))).toBe("The budget gate can't run (script missing), so nothing dispatches until it can.")
  })

  it('says nothing plans it without a launcher', () => {
    expect(dispatchLine(REPO, status({ state: { kind: 'no-launcher' } }))).toBe("This app can't launch stage sessions, so nothing plans it yet.")
  })

  it('reports a draining repository before reading the dispatcher state', () => {
    expect(dispatchLine(REPO, status({ runState: 'draining', state: { kind: 'no-launcher' } }))).toBe('acme/widgets is draining, so nothing new starts. Run it to start planning.')
  })

  it('reports a paused repository before reading the dispatcher state', () => {
    expect(dispatchLine(REPO, status({ runState: 'paused', state: { kind: 'at-capacity', limit: 3, waiting: 1 } }))).toBe('acme/widgets is paused. Run it to start planning.')
  })

  it('reads the owner before the run state', () => {
    expect(dispatchLine(REPO, status({ owner: 'terminal', runState: 'paused' }))).toBe('Your terminal cockpit runs acme/widgets and plans it on its next tick.')
    expect(dispatchLine(REPO, status({ owner: 'none', runState: 'paused' }))).toBe('Nothing runs acme/widgets yet. Run it to start planning.')
  })

  it('names why an unreadable owner is unreadable', () => {
    expect(dispatchLine(REPO, status({ owner: 'unreadable', unreadableMessage: 'EACCES' }))).toBe("Couldn't tell who runs acme/widgets (EACCES), so planning may not start.")
    expect(dispatchLine(REPO, status({ owner: 'unreadable' }))).toBe("Couldn't tell who runs acme/widgets (unknown reason), so planning may not start.")
  })

  it('admits it when the board never refreshed', () => {
    expect(dispatchLine(REPO, undefined)).toBe("Couldn't refresh the board, so it's unclear when planning starts.")
  })
})

describe('advisoryLine', () => {
  it('is null when there is nothing to say', () => {
    expect(advisoryLine(claimable())).toBeNull()
  })

  it('lists open blockers', () => {
    expect(advisoryLine(claimable({ blockers: { ok: true, open: [blocker(12), blocker(14)], shown: 2, total: 2 } }))).toBe("Blocked by #12, #14 — it's planned anyway.")
  })

  it('reports a truncated blocker read even when no fetched blocker is open', () => {
    expect(advisoryLine(claimable({ blockers: { ok: true, open: [], shown: 3, total: 30 } }))).toBe('Showing 3 of 30 blockers.')
  })

  it('reports an unreadable blocker read', () => {
    expect(advisoryLine(claimable({ blockers: { ok: false, reason: 'timeout' } }))).toBe("Couldn't read its blockers.")
  })

  it('reports a closed issue', () => {
    expect(advisoryLine(claimable({ closed: true }))).toBe("It's closed; claiming didn't reopen it.")
  })

  it('joins every advisory into one string', () => {
    const verdict = claimable({ closed: true, blockers: { ok: true, open: [blocker(12)], shown: 1, total: 5 } })
    expect(advisoryLine(verdict)).toBe("Blocked by #12 — it's planned anyway. Showing 1 of 5 blockers. It's closed; claiming didn't reopen it.")
  })
})

describe('claimedToast', () => {
  it('leads with the claim and follows with the dispatch line', () => {
    expect(claimedToast({ repo: REPO, number: 101, verdict: claimable(), status: status({}) })).toEqual({ tone: 'success', title: '#101 claimed and assigned to you.', description: 'Planning starts now.' })
  })

  it('appends the advisory after the dispatch line', () => {
    const toast = claimedToast({ repo: REPO, number: 101, verdict: claimable({ closed: true }), status: undefined })
    expect(toast.description).toBe("Couldn't refresh the board, so it's unclear when planning starts. It's closed; claiming didn't reopen it.")
  })
})

describe('refusalCopy', () => {
  it.each([
    [{ kind: 'not-found' }, "#101 doesn't exist in acme/widgets.", null],
    [{ kind: 'not-an-issue' }, '#101 is a pull request.', "Work on claims tickets; a PR enters the pipeline when it's opened."],
    [{ kind: 'already-claimed', markerName: 'claude' }, '#101 is already in the pipeline.', 'It carries `claude`. Nothing was written.'],
  ] as const)('%j', (verdict, line, note) => {
    expect(refusalCopy(REPO, 101, verdict)).toEqual({ line, note })
  })
})

describe('applyResponseToast', () => {
  it('reports a moved issue with who holds it now', () => {
    const response: ClaimApplyResponse = { kind: 'moved', confirmed: [], current: ['bob'], readAt: 'not a date' }
    expect(applyResponseToast(REPO, 101, response)).toEqual({
      tone: 'error',
      title: '#101 changed on GitHub before the write.',
      description: "It's now assigned to @bob (read not a date). Nothing was written. Work on it again to see where it stands.",
    })
  })

  it('names no one when the assignees were cleared', () => {
    const toast = applyResponseToast(REPO, 101, { kind: 'moved', confirmed: ['alice'], current: [], readAt: 'x' })
    expect(toast.description).toContain("It's now assigned to no one")
  })

  it('maps a verdict that turned into a refusal', () => {
    expect(applyResponseToast(REPO, 101, { kind: 'refused', verdict: { kind: 'already-claimed', markerName: 'claude' } })).toEqual({
      tone: 'error',
      title: '#101 is already in the pipeline.',
      description: 'It carries `claude`. Nothing was written.',
    })
  })

  it('maps an unreachable GitHub', () => {
    expect(applyResponseToast(REPO, 101, { kind: 'preflight-failed', message: 'offline.' })).toEqual({ tone: 'error', title: "Couldn't reach GitHub.", description: 'offline. Nothing was written.' })
  })

  const outcomes: ReadonlyArray<readonly [WriteOutcome, 'success' | 'error']> = [
    [{ kind: 'applied', argv: [] }, 'success'],
    [{ kind: 'no-op' }, 'success'],
    [{ kind: 'precondition-failed', conflict: { kind: 'precondition-failed', expected: ['a'], observed: [], readAt: 't' } }, 'error'],
    [{ kind: 'terminal-owned', since: 't' }, 'error'],
    [{ kind: 'ownership-unreadable', path: 'p', message: 'm' }, 'error'],
    [{ kind: 'unresolvable-label', keys: ['marker'] }, 'error'],
    [{ kind: 'item-unavailable' }, 'error'],
    [{ kind: 'verify-failed', message: 'm' }, 'error'],
    [{ kind: 'write-failed', classification: 'unknown', stderr: 'boom', reread: null }, 'error'],
  ] as unknown as ReadonlyArray<readonly [WriteOutcome, 'success' | 'error']>

  it.each(outcomes)('maps the %j write outcome through writeOutcomeCopy with the matching tone', (outcome, tone) => {
    const copy = writeOutcomeCopy(101, outcome)
    expect(applyResponseToast(REPO, 101, { kind: 'write', outcome })).toEqual({ tone, title: copy.line, description: copy.note })
  })

  it('no longer promises a next tick on a plain applied write', () => {
    expect(writeOutcomeCopy(101, { kind: 'applied', argv: [] }).note).toBeNull()
  })
})

describe('preflightToast', () => {
  it('maps an unreachable GitHub', () => {
    expect(preflightToast(REPO, 101, { kind: 'failed', message: 'offline.' })).toEqual({ tone: 'error', title: "Couldn't reach GitHub.", description: 'offline. Nothing was written.' })
  })

  it('maps an unresolved number to not-found', () => {
    expect(preflightToast(REPO, 101, { kind: 'unresolved' })).toEqual({ tone: 'error', title: "#101 doesn't exist in acme/widgets.", description: null })
  })

  it('maps a refusing verdict', () => {
    expect(preflightToast(REPO, 101, { kind: 'refused', verdict: { kind: 'not-an-issue' } }).title).toBe('#101 is a pull request.')
  })
})

describe('takeOverPrompt and unreachableToast', () => {
  it('names everyone a take-over would remove', () => {
    expect(takeOverPrompt(101, ['alice', 'bob'])).toEqual({ title: '#101 is assigned to @alice, @bob.', description: 'Taking it over removes them, so only your pipeline dispatches it.' })
  })

  it('tells the operator to restart when the main process is gone', () => {
    expect(unreachableToast()).toEqual({ tone: 'error', title: "Couldn't reach the main process.", description: 'Nothing was written. Restart port to try again.' })
  })
})
