import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardSnapshot, NeedsYouItem } from '@/types/board'
import type { RepoId } from '@/utils/repos'
import { dismissKeyOf } from '@/renderer/needs-you/dismiss-key'

const listed = vi.hoisted(() => ({ items: [] as readonly NeedsYouItem[] }))
vi.mock('@/renderer/board/needs-you', () => ({ needsYouItems: () => listed.items }))

const { createNeedsYouNotifier } = await import('@/renderer/needs-you/notify')

const A = 'repo-a' as RepoId
const SNAPSHOT = { state: { repositories: [{ ok: true, repoId: A, displayName: 'port' }] } } as unknown as BoardSnapshot

function denial(id: string): NeedsYouItem {
  return { kind: 'stage-denial', repoId: A, repo: 'o/a', number: 552, title: 't', url: null, ticket: null, at: null, matchedRow: null, denial: { id } } as unknown as NeedsYouItem
}

function fakeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) }
}

const KEY = 'port.needsYouNotified.v1'

describe('createNeedsYouNotifier', () => {
  const send = vi.fn<(request: { title: string; body: string; focus: string | null }) => Promise<void>>()
  let dismissed: ReadonlySet<string>

  beforeEach(() => {
    send.mockReset()
    send.mockResolvedValue(undefined)
    dismissed = new Set()
    listed.items = []
  })

  function notifier(storage = fakeStorage()) {
    return { storage, ...createNeedsYouNotifier({ storage, send, dismissed: () => dismissed, now: () => new Date(0) }) }
  }

  it('seeds silently on the first read ever and persists the baseline', () => {
    listed.items = [denial('d1')]
    const { storage, evaluate } = notifier()
    evaluate(SNAPSHOT, [])
    expect(send).not.toHaveBeenCalled()
    expect(JSON.parse(storage.values.get(KEY) ?? 'null')).toEqual({ [A]: [dismissKeyOf(denial('d1'))] })
  })

  it('sends one notification for an item that arrives after the seed', () => {
    const { evaluate } = notifier()
    evaluate(SNAPSHOT, [])
    listed.items = [denial('d1')]
    evaluate(SNAPSHOT, [])
    expect(send).toHaveBeenCalledTimes(1)
    const request = send.mock.calls[0]?.[0]
    expect(request?.title).toBe('port · #552')
    expect(request?.focus).toBe(dismissKeyOf(denial('d1')))
    expect(request?.body).not.toBe('')
  })

  it('does not repeat itself on the next read of the same items', () => {
    const { evaluate } = notifier()
    evaluate(SNAPSHOT, [])
    listed.items = [denial('d1')]
    evaluate(SNAPSHOT, [])
    evaluate(SNAPSHOT, [])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('stays silent after a relaunch over the same items', () => {
    listed.items = [denial('d1')]
    const first = notifier()
    first.evaluate(SNAPSHOT, [])
    const relaunched = notifier(first.storage)
    relaunched.evaluate(SNAPSHOT, [])
    expect(send).not.toHaveBeenCalled()
  })

  it('stays silent for a dismissed item, which the visible-items filter drops before the diff', () => {
    const { evaluate } = notifier()
    evaluate(SNAPSHOT, [])
    dismissed = new Set([dismissKeyOf(denial('d1'))])
    listed.items = [denial('d1')]
    evaluate(SNAPSHOT, [])
    expect(send).not.toHaveBeenCalled()
  })

  it('collapses several arrivals in one read into one notification', () => {
    const { evaluate } = notifier()
    evaluate(SNAPSHOT, [])
    listed.items = [denial('d1'), denial('d2'), denial('d3')]
    evaluate(SNAPSHOT, [])
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ title: 'port', body: '3 new items need you', focus: null })
  })

  it.each(['not json', '[1]', '{"repo-a":[1]}', '"text"'])('reads a malformed stored value (%s) as a silent seed', (stored) => {
    listed.items = [denial('d1')]
    notifier(fakeStorage({ [KEY]: stored })).evaluate(SNAPSHOT, [])
    expect(send).not.toHaveBeenCalled()
  })

  it('survives a storage write failure and still notifies', () => {
    const failing = { getItem: () => JSON.stringify({}), setItem: () => { throw new Error('quota') } }
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    listed.items = [denial('d1')]
    createNeedsYouNotifier({ storage: failing, send, dismissed: () => dismissed, now: () => new Date(0) }).evaluate(SNAPSHOT, [])
    expect(send).toHaveBeenCalledTimes(1)
    quiet.mockRestore()
  })

  it('logs a rejected send instead of throwing', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    send.mockRejectedValue(new Error('no main'))
    const { evaluate } = notifier()
    evaluate(SNAPSHOT, [])
    listed.items = [denial('d1')]
    evaluate(SNAPSHOT, [])
    await vi.waitFor(() => expect(quiet).toHaveBeenCalled())
    quiet.mockRestore()
  })
})
