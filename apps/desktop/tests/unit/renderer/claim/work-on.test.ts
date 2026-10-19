import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/renderer/data/invoke', () => ({ invoke: vi.fn() }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), loading: vi.fn() } }))

import { toast } from 'sonner'
import { invoke } from '@/renderer/data/invoke'
import { workOn } from '@/renderer/claim/work-on'
import type { ClaimApplyResponse, ClaimPreflightResponse } from '@/types/claim'
import type { RepoId } from '@/utils/repos'

const REPO_ID = 'repo-1' as RepoId
const ID = 'work-on:repo-1:101'

interface Routes {
  preflight?: ClaimPreflightResponse | Error
  apply?: ClaimApplyResponse | Error
  refresh?: unknown
}

function preflight(assigneeSituation: 'unassigned' | 'mine' | 'others', assignees: readonly string[]): ClaimPreflightResponse {
  return {
    kind: 'resolved',
    preflight: { kind: 'issue', number: 101, title: 'Fix the thing', url: 'u', state: 'OPEN', labels: [], assignees, viewer: 'octocat', blockers: { ok: true, open: [], shown: 0, total: 0 }, readAt: 't' },
    verdict: { kind: 'claimable', assigneeSituation, others: assigneeSituation === 'others' ? assignees : [], closed: false, blockers: { ok: true, open: [], shown: 0, total: 0 } },
  }
}

const APPLIED: ClaimApplyResponse = { kind: 'write', outcome: { kind: 'applied', argv: [] } }
const SNAPSHOT = { dispatch: [{ repoId: REPO_ID, owner: 'app', state: { kind: 'idle' }, runState: 'dispatching' }] }

function route(routes: Routes): void {
  vi.mocked(invoke).mockImplementation(((channel: string) => {
    const result = channel === 'claim:preflight' ? routes.preflight : channel === 'claim:apply' ? routes.apply : routes.refresh
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
  }) as never)
}

function channels(): string[] {
  return vi.mocked(invoke).mock.calls.map(([channel]) => channel)
}

function params(onClaimed = vi.fn()) {
  return { repoId: REPO_ID, repo: 'acme/widgets', number: 101, planGate: 'auto' as const, onClaimed }
}

interface PromptButtons {
  readonly action: { readonly onClick: (event: { preventDefault: () => void }) => void }
  readonly cancel: { readonly onClick: () => void }
}

function promptButtons(): PromptButtons {
  return vi.mocked(toast.info).mock.calls[0]?.[1] as unknown as PromptButtons
}

function takeOverButton(): PromptButtons['action'] {
  return promptButtons().action
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('workOn', () => {
  it('claims an unassigned issue: preflight, then apply, then refresh, with one success toast', async () => {
    route({ preflight: preflight('unassigned', []), apply: APPLIED, refresh: SNAPSHOT })
    const args = params()
    await workOn(args)

    expect(channels()).toEqual(['claim:preflight', 'claim:apply', 'board:refresh'])
    expect(invoke).toHaveBeenNthCalledWith(2, 'claim:apply', { repoId: REPO_ID, number: 101, planGate: 'auto', confirmedAssignees: [] })
    expect(invoke).toHaveBeenNthCalledWith(3, 'board:refresh', { repoId: REPO_ID, source: 'github' })
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toBe('#101 claimed and assigned to you.')
    expect(vi.mocked(toast.success).mock.calls[0]?.[1]).toMatchObject({ id: ID, description: 'Planning starts now.' })
    expect(args.onClaimed).toHaveBeenCalledTimes(1)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('claims an issue already assigned to the viewer with the viewer as the confirmed assignee', async () => {
    route({ preflight: preflight('mine', ['octocat']), apply: APPLIED, refresh: SNAPSHOT })
    await workOn(params())
    expect(invoke).toHaveBeenNthCalledWith(2, 'claim:apply', { repoId: REPO_ID, number: 101, planGate: 'auto', confirmedAssignees: ['octocat'] })
  })

  it('writes nothing for an issue assigned to someone else until Take over is clicked', async () => {
    route({ preflight: preflight('others', ['alice']), apply: APPLIED, refresh: SNAPSHOT })
    const args = params()
    await workOn(args)

    expect(channels()).toEqual(['claim:preflight'])
    expect(vi.mocked(toast.info).mock.calls[0]?.[0]).toBe('#101 is assigned to @alice.')
    expect(vi.mocked(toast.info).mock.calls[0]?.[1]).toMatchObject({ id: ID, duration: Infinity })

    const preventDefault = vi.fn()
    takeOverButton().onClick({ preventDefault })
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(channels().filter((channel) => channel === 'claim:apply')).toHaveLength(1)
    expect(invoke).toHaveBeenCalledWith('claim:apply', { repoId: REPO_ID, number: 101, planGate: 'auto', confirmedAssignees: ['alice'] })
    expect(toast.loading).toHaveBeenCalledWith('Taking over #101…', expect.objectContaining({ id: ID }))
    expect(args.onClaimed).toHaveBeenCalledTimes(1)
  })

  it('leaves the issue alone when the take-over prompt is declined', async () => {
    route({ preflight: preflight('others', ['alice']), apply: APPLIED, refresh: SNAPSHOT })
    await workOn(params())
    promptButtons().cancel.onClick()
    expect(channels()).toEqual(['claim:preflight'])
  })

  it.each([
    ['a refusal', { kind: 'resolved', preflight: preflight('unassigned', []), verdict: { kind: 'already-claimed', markerName: 'claude' } }],
    ['an unresolved number', { kind: 'unresolved' }],
    ['an unreachable GitHub', { kind: 'failed', message: 'offline.' }],
  ] as const)('stops after the preflight on %s, with one error toast and no write', async (_name, response) => {
    route({ preflight: response as unknown as ClaimPreflightResponse })
    const args = params()
    await workOn(args)

    expect(channels()).toEqual(['claim:preflight'])
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(args.onClaimed).not.toHaveBeenCalled()
  })

  it.each([
    ['moved', { kind: 'moved', confirmed: [], current: ['bob'], readAt: 't' }],
    ['precondition-failed', { kind: 'write', outcome: { kind: 'precondition-failed', conflict: { kind: 'precondition-failed', expected: [], observed: ['x'], readAt: 't' } } }],
    ['preflight-failed', { kind: 'preflight-failed', message: 'offline.' }],
  ] as const)('reports a %s apply as an error and never calls onClaimed', async (_name, response) => {
    route({ preflight: preflight('unassigned', []), apply: response })
    const args = params()
    await workOn(args)

    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.success).not.toHaveBeenCalled()
    expect(args.onClaimed).not.toHaveBeenCalled()
    expect(channels()).not.toContain('board:refresh')
  })

  it('reports a no-op write as a success without a dispatch line', async () => {
    route({ preflight: preflight('unassigned', []), apply: { kind: 'write', outcome: { kind: 'no-op' } }, refresh: SNAPSHOT })
    const args = params()
    await workOn(args)

    expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toBe('#101 already carries those labels.')
    expect(args.onClaimed).toHaveBeenCalledTimes(1)
  })

  it('still reports success, with the refresh-failed dispatch line, when board:refresh rejects', async () => {
    route({ preflight: preflight('unassigned', []), apply: APPLIED, refresh: new Error('boom') })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await workOn(params())

    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast.success).mock.calls[0]?.[1]).toMatchObject({ description: "Couldn't refresh the board, so it's unclear when planning starts." })
  })

  it('shows the main-process toast when the preflight invoke rejects', async () => {
    route({ preflight: new Error('gone') })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await workOn(params())

    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toBe("Couldn't reach the main process.")
    expect(channels()).toEqual(['claim:preflight'])
  })

  it('shows the main-process toast when the apply invoke rejects', async () => {
    route({ preflight: preflight('unassigned', []), apply: new Error('gone') })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const args = params()
    await workOn(args)

    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toBe("Couldn't reach the main process.")
    expect(args.onClaimed).not.toHaveBeenCalled()
  })

  it('gives every toast for one row the same id, and clears a previous prompt\'s buttons', async () => {
    route({ preflight: preflight('others', ['alice']), apply: APPLIED, refresh: SNAPSHOT })
    await workOn(params())
    takeOverButton().onClick({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))

    const calls = [toast.info, toast.loading, toast.success].flatMap((fn) => vi.mocked(fn).mock.calls)
    expect(calls).toHaveLength(3)
    for (const [, options] of calls) expect(options).toMatchObject({ id: ID })
    expect(vi.mocked(toast.success).mock.calls[0]?.[1]).toMatchObject({ action: undefined, cancel: undefined, duration: undefined })
    expect(vi.mocked(toast.loading).mock.calls[0]?.[1]).toMatchObject({ action: undefined, cancel: undefined, duration: undefined, description: undefined })
  })
})
