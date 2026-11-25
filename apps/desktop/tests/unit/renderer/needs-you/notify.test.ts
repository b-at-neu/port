import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardSnapshot, NeedsYouItem } from '@/types/board'
import type { RepoId } from '@/utils/repos'

const listed = vi.hoisted(() => ({ items: [] as readonly NeedsYouItem[] }))
vi.mock('@/renderer/board/needs-you', () => ({ needsYouItems: () => listed.items }))

const { createNeedsYouNotifier } = await import('@/renderer/needs-you/notify')

const A = 'repo-a' as RepoId
const SNAPSHOT = { state: { repositories: [{ ok: true, repoId: A, displayName: 'port' }] } } as unknown as BoardSnapshot
const KEY = 'port.needsYouNotified.v1'

function denial(id: string): NeedsYouItem {
  return { kind: 'stage-denial', repoId: A, repo: 'o/a', number: 552, title: 't', url: null, ticket: null, at: null, matchedRow: null, denial: { id } } as unknown as NeedsYouItem
}

function fakeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) }
}

describe('createNeedsYouNotifier storage edges', () => {
  const send = vi.fn<(request: { title: string; body: string; focus: string | null }) => Promise<void>>()

  function notifier(storage: Pick<Storage, 'getItem' | 'setItem'>) {
    return createNeedsYouNotifier({ storage, send, dismissed: () => new Set(), now: () => new Date(0) })
  }

  beforeEach(() => {
    send.mockReset()
    send.mockResolvedValue(undefined)
    listed.items = []
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
    notifier(failing).evaluate(SNAPSHOT, [])
    expect(send).toHaveBeenCalledTimes(1)
    quiet.mockRestore()
  })

  it('logs a rejected send instead of throwing', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    send.mockRejectedValue(new Error('no main'))
    const { evaluate } = notifier(fakeStorage())
    evaluate(SNAPSHOT, [])
    listed.items = [denial('d1')]
    evaluate(SNAPSHOT, [])
    await vi.waitFor(() => expect(quiet).toHaveBeenCalled())
    quiet.mockRestore()
  })
})
