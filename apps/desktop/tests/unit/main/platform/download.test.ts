import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'
import { createFileDownloader } from '@/main/platform/download'

const URL_ = 'https://github.com/acme/port/releases/download/v1/port-1-mac-arm64.dmg'

class FakeItem extends EventEmitter {
  savePath: string | null = null
  received = 0
  total = 0
  readonly cancel = vi.fn()
  constructor(private readonly chain: string[]) {
    super()
  }
  setSavePath(path: string): void {
    this.savePath = path
  }
  getURLChain(): string[] {
    return this.chain
  }
  getReceivedBytes(): number {
    return this.received
  }
  getTotalBytes(): number {
    return this.total
  }
}

class FakeSession extends EventEmitter {
  readonly downloadURL = vi.fn()
}

function setup() {
  const session = new FakeSession()
  const progress = vi.fn()
  const download = createFileDownloader(session as unknown as Session, { startTimeoutMs: 40 })
  const result = download({ url: URL_, savePath: '/downloads/port.dmg', onProgress: progress })
  return { session, progress, result }
}

describe('createFileDownloader', () => {
  it('asks the session for the url and listens before it does', () => {
    const { session } = setup()

    expect(session.downloadURL).toHaveBeenCalledWith(URL_)
    expect(session.listenerCount('will-download')).toBe(1)
  })

  it('sets the save path synchronously and stops listening once it has claimed the item', () => {
    const { session } = setup()
    const item = new FakeItem([URL_])

    session.emit('will-download', {}, item)

    expect(item.savePath).toBe('/downloads/port.dmg')
    expect(session.listenerCount('will-download')).toBe(0)
  })

  it('ignores an item for another url', () => {
    const { session } = setup()
    const other = new FakeItem(['https://example.test/other.zip'])

    session.emit('will-download', {}, other)

    expect(other.savePath).toBeNull()
    expect(session.listenerCount('will-download')).toBe(1)
  })

  it('reports received and total bytes on each update', () => {
    const { session, progress } = setup()
    const item = new FakeItem([URL_])
    session.emit('will-download', {}, item)

    item.received = 50
    item.total = 200
    item.emit('updated', {}, 'progressing')

    expect(progress).toHaveBeenCalledWith(50, 200)
  })

  it('resolves ok with the saved path when the download completes', async () => {
    const { session, result } = setup()
    const item = new FakeItem([URL_])
    session.emit('will-download', {}, item)

    item.received = 200
    item.emit('done', {}, 'completed')

    expect(await result).toEqual({ ok: true, path: '/downloads/port.dmg', receivedBytes: 200 })
  })

  it.each(['interrupted', 'cancelled'])('resolves an %s download as interrupted with its state', async (state) => {
    const { session, result } = setup()
    const item = new FakeItem([URL_])
    session.emit('will-download', {}, item)

    item.emit('done', {}, state)

    expect(await result).toEqual({ ok: false, reason: 'interrupted', detail: state })
  })

  it('times out when no download starts, and cancels a late item instead of letting it save', async () => {
    const { session, result } = setup()

    expect(await result).toEqual({ ok: false, reason: 'interrupted', detail: 'download never started' })

    const late = new FakeItem([URL_])
    session.emit('will-download', {}, late)
    expect(late.cancel).toHaveBeenCalledOnce()
    expect(late.savePath).toBeNull()
    expect(session.listenerCount('will-download')).toBe(0)
  })

  it('stops watching for a late item after a further timeout window', async () => {
    const { session, result } = setup()
    await result

    await new Promise((done) => setTimeout(done, 80))

    expect(session.listenerCount('will-download')).toBe(0)
  })

  it('does not cancel a retry started inside the late-item window', async () => {
    const session = new FakeSession()
    const download = createFileDownloader(session as unknown as Session, { startTimeoutMs: 40 })
    const first = download({ url: URL_, savePath: '/downloads/port.dmg', onProgress: vi.fn() })
    await first

    const retry = download({ url: URL_, savePath: '/downloads/port.dmg', onProgress: vi.fn() })
    const item = new FakeItem([URL_])
    session.emit('will-download', {}, item)
    item.received = 200
    item.emit('done', {}, 'completed')

    expect(item.cancel).not.toHaveBeenCalled()
    expect(item.savePath).toBe('/downloads/port.dmg')
    expect(await retry).toMatchObject({ ok: true })
  })

  it('does not time out once the download has started', async () => {
    const { session, result } = setup()
    const item = new FakeItem([URL_])
    session.emit('will-download', {}, item)

    await new Promise((done) => setTimeout(done, 120))
    item.received = 10
    item.emit('done', {}, 'completed')

    expect(await result).toMatchObject({ ok: true })
  })
})
