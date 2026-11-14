import { describe, expect, it } from 'vitest'
import { resolveUpdateCheck, resolveUpdateDownload, resolveUpdateDownloadState, resolveUpdateOpen, resolveUpdateState } from '@/main/channels/update'
import type { UpdateDownloader, UpdateDownloadState, UpdateService, UpdateState } from '@/types/update'

const STATE: UpdateState = { kind: 'idle', current: '1.4.0' }

function serviceOf(calls: string[] = []): UpdateService {
  return {
    state: () => STATE,
    check: (trigger) => {
      calls.push(trigger)
      return Promise.resolve(STATE)
    },
  }
}

describe('resolveUpdateState', () => {
  it('returns the cached state', () => {
    expect(resolveUpdateState(undefined, serviceOf())).toBe(STATE)
  })

  it.each([null, {}, 'x', 0])('throws on the payload %j', (payload) => {
    expect(() => resolveUpdateState(payload, serviceOf())).toThrow("'update:state' takes no payload")
  })
})

const DOWNLOAD: UpdateDownloadState = { kind: 'idle' }

function downloaderOf(calls: string[] = []): UpdateDownloader {
  return {
    state: () => DOWNLOAD,
    start: () => {
      calls.push('start')
      return Promise.resolve(DOWNLOAD)
    },
    open: (reveal) => {
      calls.push(`open:${String(reveal)}`)
      return Promise.resolve(DOWNLOAD)
    },
  }
}

describe('resolveUpdateDownload', () => {
  it('starts a download', async () => {
    const calls: string[] = []
    expect(await resolveUpdateDownload(undefined, downloaderOf(calls))).toBe(DOWNLOAD)
    expect(calls).toEqual(['start'])
  })

  it.each([null, {}, 'x', 0])('throws on the payload %j without starting', (payload) => {
    const calls: string[] = []
    expect(() => resolveUpdateDownload(payload, downloaderOf(calls))).toThrow("'update:download' takes no payload")
    expect(calls).toEqual([])
  })
})

describe('resolveUpdateDownloadState', () => {
  it('returns the cached state', () => {
    expect(resolveUpdateDownloadState(undefined, downloaderOf())).toBe(DOWNLOAD)
  })

  it.each([null, {}, 'x', 0])('throws on the payload %j', (payload) => {
    expect(() => resolveUpdateDownloadState(payload, downloaderOf())).toThrow("'update:download:state' takes no payload")
  })
})

describe('resolveUpdateOpen', () => {
  it.each([true, false])('passes reveal %j through', async (reveal) => {
    const calls: string[] = []
    expect(await resolveUpdateOpen({ reveal }, downloaderOf(calls))).toBe(DOWNLOAD)
    expect(calls).toEqual([`open:${String(reveal)}`])
  })

  it.each([undefined, null, {}, { reveal: 'yes' }, { reveal: 1 }, { reveal: true, path: '/x' }, 'x'])('throws on the payload %j without opening', (payload) => {
    const calls: string[] = []
    expect(() => resolveUpdateOpen(payload, downloaderOf(calls))).toThrow("'update:open' takes exactly { reveal: boolean }")
    expect(calls).toEqual([])
  })
})

describe('resolveUpdateCheck', () => {
  it('runs a manual check', async () => {
    const calls: string[] = []
    expect(await resolveUpdateCheck(undefined, serviceOf(calls))).toBe(STATE)
    expect(calls).toEqual(['manual'])
  })

  it.each([null, {}, 'x', 0])('throws on the payload %j without checking', (payload) => {
    const calls: string[] = []
    expect(() => resolveUpdateCheck(payload, serviceOf(calls))).toThrow("'update:check' takes no payload")
    expect(calls).toEqual([])
  })
})
