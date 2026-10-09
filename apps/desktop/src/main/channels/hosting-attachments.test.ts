import { describe, expect, it, vi } from 'vitest'
import type { SessionKey } from '../../shared/hosting/types'
import type { HostedStore } from '../hosting/store'
import { resolveSessionFiles, resolveSessionSend } from './hosting'
import type { HostingChannelDeps } from './hosting'

const SESSION_KEY = 'hosted-1' as SessionKey

function storeStub(overrides: Partial<HostedStore> = {}): HostedStore {
  return {
    start: () => {
      throw new Error('start should not be invoked in this case')
    },
    send: () => {
      throw new Error('send should not be invoked in this case')
    },
    interrupt: () => {
      throw new Error('interrupt should not be invoked in this case')
    },
    close: () => {
      throw new Error('close should not be invoked in this case')
    },
    attach: () => {
      throw new Error('attach should not be invoked in this case')
    },
    list: () => {
      throw new Error('list should not be invoked in this case')
    },
    closeAll: () => {
      throw new Error('closeAll should not be invoked in this case')
    },
    answerPermission: () => {
      throw new Error('answerPermission should not be invoked in this case')
    },
    invoke: () => {
      throw new Error('invoke should not be invoked in this case')
    },
    dismiss: () => {
      throw new Error('dismiss should not be invoked in this case')
    },
    snapshotOf: () => {
      throw new Error('snapshotOf should not be invoked in this case')
    },
    cwdOf: () => {
      throw new Error('cwdOf should not be invoked in this case')
    },
    capacity: () => {
      throw new Error('capacity should not be invoked in this case')
    },
    setLimit: () => {
      throw new Error('setLimit should not be invoked in this case')
    },
    defaults: () => {
      throw new Error('defaults should not be invoked in this case')
    },
    setDefaults: () => {
      throw new Error('setDefaults should not be invoked in this case')
    },
    rename: () => {
      throw new Error('rename should not be invoked in this case')
    },
    restorable: () => {
      throw new Error('restorable should not be invoked in this case')
    },
    restore: () => {
      throw new Error('restore should not be invoked in this case')
    },
    discardRestorable: () => {
      throw new Error('discardRestorable should not be invoked in this case')
    },
    setControls: () => {
      throw new Error('setControls should not be invoked in this case')
    },
    answerQuestion: () => {
      throw new Error('answerQuestion should not be invoked in this case')
    },
    answerPlan: () => {
      throw new Error('answerPlan should not be invoked in this case')
    },
    ...overrides,
  }
}

function depsWith(overrides: Partial<HostingChannelDeps> = {}): HostingChannelDeps {
  return {
    listRepositories: () => Promise.resolve({ ok: true, repositories: [] }),
    store: storeStub(),
    listSessionFiles: () => {
      throw new Error('listSessionFiles should not be invoked in this case')
    },
    resolveStartTarget: () => {
      throw new Error('resolveStartTarget should not be invoked in this case')
    },
    targetDeps: {
      git: () => {
        throw new Error('git should not be invoked in this case')
      },
      recents: { load: () => Promise.resolve([]), record: () => Promise.resolve() },
      exists: () => Promise.resolve(true),
      readSessions: () => Promise.resolve({ ok: true, sessions: [] }),
      createWorktree: () => Promise.resolve({ ok: false, message: 'should not be called' }),
    },
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    removeCreatedWorktree: () => Promise.resolve(),
    ...overrides,
  }
}

describe('resolveSessionSend attachments', () => {
  it('accepts empty text when at least one attachment is present', () => {
    const send = vi.fn(() => ({ ok: true as const, uuid: 'u', queued: true }))
    const attachments = [{ kind: 'text' as const, name: 'notes.txt', text: 'hi' }]
    resolveSessionSend({ sessionKey: SESSION_KEY, text: '', attachments }, depsWith({ store: storeStub({ send }) }))
    expect(send).toHaveBeenCalledWith(SESSION_KEY, '', attachments)
  })

  it('rejects an attachment with an unknown kind', () => {
    expect(() => resolveSessionSend({ sessionKey: SESSION_KEY, text: '', attachments: [{ kind: 'video', name: 'a' } as never] }, depsWith())).toThrow(
      "'session:send' requires every attachment 'kind' to be one of image, pdf, text",
    )
  })

  it('rejects an image attachment with a media type outside the allowlist', () => {
    expect(() =>
      resolveSessionSend({ sessionKey: SESSION_KEY, text: '', attachments: [{ kind: 'image', name: 'a.heic', mediaType: 'image/heic', data: 'QQ==' } as never] }, depsWith()),
    ).toThrow(/mediaType/)
  })

  it('rejects an attachment whose data is not base64', () => {
    expect(() =>
      resolveSessionSend({ sessionKey: SESSION_KEY, text: '', attachments: [{ kind: 'image', name: 'a.png', mediaType: 'image/png', data: 'not base64!' } as never] }, depsWith()),
    ).toThrow(/base64/)
  })

  it('rejects an image attachment over its size limit', () => {
    const oversized = 'A'.repeat(7_000_000)
    expect(() => resolveSessionSend({ sessionKey: SESSION_KEY, text: '', attachments: [{ kind: 'image', name: 'a.png', mediaType: 'image/png', data: oversized } as never] }, depsWith())).toThrow(
      /at most/,
    )
  })

  it('rejects more than the attachment count cap', () => {
    const attachments = Array.from({ length: 11 }, (_, i) => ({ kind: 'text' as const, name: `f${String(i)}.txt`, text: 'x' }))
    expect(() => resolveSessionSend({ sessionKey: SESSION_KEY, text: '', attachments }, depsWith())).toThrow('at most 10 attachments')
  })

  it('rejects an attachment name with control characters', () => {
    expect(() => resolveSessionSend({ sessionKey: SESSION_KEY, text: '', attachments: [{ kind: 'text', name: 'a\u0007b', text: 'x' }] }, depsWith())).toThrow(/control characters/)
  })
})

describe('resolveSessionFiles', () => {
  it('rejects a missing sessionKey', async () => {
    await expect(resolveSessionFiles({ sessionKey: undefined as unknown as SessionKey }, depsWith())).rejects.toThrow("'session:files' requires a non-empty 'sessionKey'")
  })

  it('reports unknown-session for a key naming no live handle, never reading files', async () => {
    const result = await resolveSessionFiles({ sessionKey: SESSION_KEY }, depsWith({ store: storeStub({ cwdOf: () => null }) }))
    expect(result).toEqual({ ok: false, kind: 'unknown-session' })
  })

  it("resolves the handle's own cwd and lists its files", async () => {
    const listSessionFiles = vi.fn(() => Promise.resolve({ ok: true as const, files: ['a.ts', 'b.ts'], truncated: false }))
    const result = await resolveSessionFiles({ sessionKey: SESSION_KEY }, depsWith({ store: storeStub({ cwdOf: () => '/repo' }), listSessionFiles }))
    expect(listSessionFiles).toHaveBeenCalledWith('/repo')
    expect(result).toEqual({ ok: true, files: ['a.ts', 'b.ts'], truncated: false })
  })

  it('reports unreadable, never an empty list, when the read fails', async () => {
    const listSessionFiles = vi.fn(() => Promise.resolve({ ok: false as const, message: 'denied' }))
    const result = await resolveSessionFiles({ sessionKey: SESSION_KEY }, depsWith({ store: storeStub({ cwdOf: () => '/repo' }), listSessionFiles }))
    expect(result).toEqual({ ok: false, kind: 'unreadable', message: 'denied' })
  })
})
