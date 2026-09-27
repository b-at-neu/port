// #98's own acceptance run — the ticket's acceptance criterion ("start,
// stream, interrupt mid-turn, close cleanly, then resume and fork that same
// session") end to end, against the real Agent SDK and a real `claude`
// child process. Skipped unless `PORT_LIVE_SDK=1`, and stays out of
// `commands.checks` and the default `pnpm test` run — this is the only
// place under `apps/desktop/` that exercises the real child process before
// #219 exists.
//
// `PORT_LIVE_SDK_CWD` names the registered, `ready` repository to run
// against (a real git checkout with Claude Code logged in); the run is
// skipped with a clear reason when it is not set, never silently no-op'd.
import { describe, expect, it } from 'vitest'
import { createHostedStore, defaultHostedStoreDeps } from './store'
import type { RepoId } from '../../shared/repos'

const live = process.env['PORT_LIVE_SDK'] === '1'
const cwd = process.env['PORT_LIVE_SDK_CWD']

describe.skipIf(!live || !cwd)('hosting — live SDK acceptance (PORT_LIVE_SDK=1)', () => {
  it('starts, streams a turn, interrupts, closes, resumes, and forks', async () => {
    if (!cwd) throw new Error('PORT_LIVE_SDK=1 requires PORT_LIVE_SDK_CWD to name a registered, ready repository')
    const store = createHostedStore(defaultHostedStoreDeps)
    const repoId = 'live-acceptance' as RepoId

    const started = await store.start({ repoId, mode: { kind: 'fresh' }, cwd })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const sessionKey = started.snapshot.sessionKey

    store.send(sessionKey, 'Reply with only the word "ok" and stop.')
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    await store.interrupt(sessionKey)
    await store.close(sessionKey)

    const attached = store.attach(sessionKey)
    expect(attached.ok).toBe(true)
    if (!attached.ok) return
    const claudeSessionId = attached.snapshot.claudeSessionId
    expect(claudeSessionId).not.toBeNull()
    if (claudeSessionId === null) return

    const resumed = await store.start({ repoId, mode: { kind: 'resume', sessionId: claudeSessionId }, cwd })
    expect(resumed.ok).toBe(true)
    if (resumed.ok) await store.close(resumed.snapshot.sessionKey)

    const forked = await store.start({ repoId, mode: { kind: 'fork', sessionId: claudeSessionId }, cwd })
    expect(forked.ok).toBe(true)
    if (!forked.ok) return
    expect(forked.snapshot.origin).toEqual({ kind: 'forked', from: claudeSessionId, atMessageUuid: null })
    await store.close(forked.snapshot.sessionKey)

    await store.closeAll()
  }, 60_000)
})
