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
import { access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createHostedStore, defaultHostedStoreDeps } from './store'
import type { RepoId } from '../../shared/repos'
import type { HostedSessionSnapshot, PendingPermission, SessionEntriesDelta, SessionKey } from '../../shared/hosting/types'

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

  it('#99: a Write outside cwd always prompts — deny leaves no file, allow-once creates it', async () => {
    if (!cwd) throw new Error('PORT_LIVE_SDK=1 requires PORT_LIVE_SDK_CWD to name a registered, ready repository')
    const target = join(tmpdir(), `port-permission-probe-${Date.now()}.txt`)
    await rm(target, { force: true })

    let latest: HostedSessionSnapshot | null = null
    const store = createHostedStore({ ...defaultHostedStoreDeps, onStatus: (snapshot) => (latest = snapshot) })
    const repoId = 'live-permission-acceptance' as RepoId

    try {
      const started = await store.start({ repoId, mode: { kind: 'fresh' }, cwd })
      expect(started.ok).toBe(true)
      if (!started.ok) return
      const sessionKey = started.snapshot.sessionKey

      store.send(sessionKey, `Use the Write tool to write the text "hi" to the exact path ${target}. Do not ask, just call the tool.`)

      const deniedPrompt = await waitForPendingPermission(() => latest, sessionKey)
      store.answerPermission(sessionKey, deniedPrompt.permissionId, 'deny', 'not this time')
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      expect(await fileExists(target)).toBe(false)

      store.send(sessionKey, `Use the Write tool again to write the text "hi" to the exact path ${target}. Do not ask, just call the tool.`)
      const secondPrompt = await waitForPendingPermission(() => latest, sessionKey)
      store.answerPermission(sessionKey, secondPrompt.permissionId, 'allow-once', null)
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      expect(await fileExists(target)).toBe(true)

      await store.close(sessionKey)
    } finally {
      await rm(target, { force: true })
      await store.closeAll()
    }
  }, 60_000)

  // #219: the one check of the SDK shape assumptions in project.ts's own
  // header (no prompt echo, user_message_uuids on the first frame,
  // queued_turn_count on result) against the real CLI, rather than a fake.
  it('#219: partial text streams before the phase reads streaming, and an assistant entry lands', async () => {
    if (!cwd) throw new Error('PORT_LIVE_SDK=1 requires PORT_LIVE_SDK_CWD to name a registered, ready repository')
    const entries: SessionEntriesDelta[] = []
    const statuses: HostedSessionSnapshot['phase'][] = []
    const store = createHostedStore({
      ...defaultHostedStoreDeps,
      onEntries: (delta) => entries.push(delta),
      onStatus: (snapshot) => statuses.push(snapshot.phase),
    })
    const repoId = 'live-entries-acceptance' as RepoId

    const started = await store.start({ repoId, mode: { kind: 'fresh' }, cwd })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const sessionKey = started.snapshot.sessionKey

    store.send(sessionKey, 'Reply with only the word "ok" and stop.')

    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && !entries.some((delta) => delta.appended.some((entry) => entry.type === 'assistant-text'))) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    const firstAssistantTextIndex = entries.findIndex((delta) => delta.appended.some((entry) => entry.type === 'assistant-text'))
    const firstPartialAppendIndex = entries.findIndex((delta) => delta.partial?.op === 'append')
    expect(firstPartialAppendIndex).toBeGreaterThanOrEqual(0)
    expect(firstPartialAppendIndex).toBeLessThanOrEqual(firstAssistantTextIndex === -1 ? Infinity : firstAssistantTextIndex)

    const streamingIndex = statuses.indexOf('streaming')
    const readyIndexAfterStreaming = statuses.indexOf('ready', streamingIndex + 1)
    expect(streamingIndex).toBeGreaterThanOrEqual(0)
    expect(readyIndexAfterStreaming).toBeGreaterThan(streamingIndex)

    await store.close(sessionKey)
    await store.closeAll()
  }, 60_000)
})

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Polls the latest captured snapshot for the named session until it
 *  carries at least one pending permission, or throws after a bounded wait
 *  — the SDK's own round trip to the real `claude` child has no fixed
 *  latency this test can await directly. */
async function waitForPendingPermission(latest: () => HostedSessionSnapshot | null, sessionKey: SessionKey): Promise<PendingPermission> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const snapshot = latest()
    if (snapshot?.sessionKey === sessionKey && snapshot.pendingPermissions.length > 0) {
      const first = snapshot.pendingPermissions[0]
      if (first) return first
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Timed out waiting for a pending permission request')
}
