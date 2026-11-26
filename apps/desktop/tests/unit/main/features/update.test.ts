import { describe, expect, it } from 'vitest'
import type { UpdateDownloadState, UpdateState } from '@/types/update'
import { callAction, createTestContext } from '../../../support/context'

const STATE: UpdateState = { kind: 'idle', current: '1.4.0' }
const DOWNLOAD: UpdateDownloadState = { kind: 'idle' }

function setup() {
  const calls: string[] = []
  const ctx = createTestContext({
    live: {
      update: {
        service: {
          state: () => STATE,
          check: (trigger) => {
            calls.push(`check:${trigger}`)
            return Promise.resolve(STATE)
          },
        },
        downloader: {
          state: () => DOWNLOAD,
          start: () => {
            calls.push('start')
            return Promise.resolve(DOWNLOAD)
          },
          open: (reveal) => {
            calls.push(`open:${String(reveal)}`)
            return Promise.resolve(DOWNLOAD)
          },
        },
      },
    },
  })
  return { ctx, calls }
}

describe('update actions', () => {
  it('returns the cached update and download state', async () => {
    const { ctx } = setup()
    expect(await callAction(ctx, 'update.state')).toBe(STATE)
    expect(await callAction(ctx, 'update.downloadState')).toBe(DOWNLOAD)
  })

  it('runs a manual check and starts a download', async () => {
    const { ctx, calls } = setup()
    expect(await callAction(ctx, 'update.check')).toBe(STATE)
    expect(await callAction(ctx, 'update.download')).toBe(DOWNLOAD)
    expect(calls).toEqual(['check:manual', 'start'])
  })

  it.each([true, false])('passes reveal %j through', async (reveal) => {
    const { ctx, calls } = setup()
    expect(await callAction(ctx, 'update.open', { reveal })).toBe(DOWNLOAD)
    expect(calls).toEqual([`open:${String(reveal)}`])
  })

  it.each([undefined, null, {}, { reveal: 'yes' }, { reveal: 1 }, { reveal: true, path: '/x' }, 'x'])('rejects the open payload %j without opening', async (payload) => {
    const { ctx, calls } = setup()
    await expect(callAction(ctx, 'update.open', payload as never)).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it.each(['update.check', 'update.download'] as const)('rejects a payload on %s without running it', async (name) => {
    const { ctx, calls } = setup()
    await expect(callAction(ctx, name, {} as never)).rejects.toThrow()
    expect(calls).toEqual([])
  })
})
