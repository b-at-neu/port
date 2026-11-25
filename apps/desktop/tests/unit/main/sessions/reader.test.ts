import { describe, expect, it } from 'vitest'
import { createSdkSessionReader } from '@/main/sessions/reader'
import type { SDKSessionInfo, SdkSource } from '@/main/platform/sdk'

function sourceOf(listSessions: () => Promise<readonly Partial<SDKSessionInfo>[]>): SdkSource<'listSessions'> {
  return { load: () => Promise.resolve({ listSessions: listSessions as () => Promise<SDKSessionInfo[]> }) }
}

describe('createSdkSessionReader — the mapper, no SDK ever loaded', () => {
  it('maps a full SDKSessionInfo fixture, carrying every field', async () => {
    const reader = createSdkSessionReader(
      sourceOf(() =>
        Promise.resolve([
          {
            sessionId: 's1',
            summary: 'a summary',
            lastModified: 1700000000000,
            fileSize: 42,
            customTitle: 'my title',
            firstPrompt: '/port:pipeline',
            gitBranch: 'main',
            cwd: '/repo',
            tag: 'x',
            createdAt: 1699999999000,
          },
        ]),
      ),
    )
    const result = await reader()
    expect(result).toEqual({
      ok: true,
      sessions: [
        {
          sessionId: 's1',
          summary: 'a summary',
          lastModified: new Date(1700000000000).toISOString(),
          customTitle: 'my title',
          firstPrompt: '/port:pipeline',
          gitBranch: 'main',
          cwd: '/repo',
        },
      ],
    })
  })

  it('maps absent optionals to null, never undefined', async () => {
    const reader = createSdkSessionReader(sourceOf(() => Promise.resolve([{ sessionId: 's1', summary: '', lastModified: 1700000000000 }])))
    const result = await reader()
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.sessions[0]).toEqual({
      sessionId: 's1',
      summary: null,
      lastModified: new Date(1700000000000).toISOString(),
      customTitle: null,
      firstPrompt: null,
      gitBranch: null,
      cwd: null,
    })
  })

  it('a rejected import() surfaces as sdk-unavailable, never a throw', async () => {
    const reader = createSdkSessionReader({ load: () => Promise.reject(new Error('module not found')) })
    const result = await reader()
    expect(result).toEqual({ ok: false, kind: 'sdk-unavailable', message: 'module not found' })
  })

  it('listSessions() throwing surfaces as sdk-failed', async () => {
    const reader = createSdkSessionReader(sourceOf(() => Promise.reject(new Error('boom'))))
    const result = await reader()
    expect(result).toEqual({ ok: false, kind: 'sdk-failed', message: 'boom' })
  })
})
