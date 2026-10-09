// An acceptance run against the real Agent SDK and a real claude child process. Skipped unless
// PORT_LIVE_SDK=1. PORT_LIVE_SDK_CWD names the ready repository to run against.
import { access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createHostedStore, defaultHostedStoreDeps } from './store'
import type { RepoId } from '../../shared/repos'
import type { HostedSessionSnapshot, PendingPermission, SessionEntriesDelta, SessionKey } from '../../shared/hosting/types'
import type { SessionWorkspace } from '../../shared/workspace/types'

const live = process.env['PORT_LIVE_SDK'] === '1'
const cwd = process.env['PORT_LIVE_SDK_CWD']

function workspaceFor(folder: string): SessionWorkspace {
  return { folder, root: null, worktree: null, base: null }
}

describe.skipIf(!live || !cwd)('hosting — live SDK acceptance (PORT_LIVE_SDK=1)', () => {
  it('starts, streams a turn, interrupts, closes, resumes, and forks', async () => {
    if (!cwd) throw new Error('PORT_LIVE_SDK=1 requires PORT_LIVE_SDK_CWD to name a registered, ready repository')
    const store = createHostedStore(defaultHostedStoreDeps)
    const repoId = 'live-acceptance' as RepoId

    const started = await store.start({ repoId, mode: { kind: 'fresh' }, workspace: workspaceFor(cwd) })
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

    const resumed = await store.start({ repoId, mode: { kind: 'resume', sessionId: claudeSessionId }, workspace: workspaceFor(cwd) })
    expect(resumed.ok).toBe(true)
    if (resumed.ok) await store.close(resumed.snapshot.sessionKey)

    const forked = await store.start({ repoId, mode: { kind: 'fork', sessionId: claudeSessionId }, workspace: workspaceFor(cwd) })
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
      const started = await store.start({ repoId, mode: { kind: 'fresh' }, workspace: workspaceFor(cwd) })
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

  // Checks the SDK shape assumptions in project.ts against the real CLI, rather than a fake.
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

    const started = await store.start({ repoId, mode: { kind: 'fresh' }, workspace: workspaceFor(cwd) })
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

  // Checks the port:<agent> naming and the --plugin-dir override against the real CLI.
  it('#101: capabilities reach ready before any send, then loaded/complete after one turn, naming the repository copy', async () => {
    if (!cwd) throw new Error('PORT_LIVE_SDK=1 requires PORT_LIVE_SDK_CWD to name a registered, ready repository')
    let latest: HostedSessionSnapshot | null = null
    const store = createHostedStore({ ...defaultHostedStoreDeps, onStatus: (snapshot) => (latest = snapshot) })
    const repoId = 'live-capabilities-acceptance' as RepoId

    const started = await store.start({ repoId, mode: { kind: 'fresh' }, workspace: workspaceFor(cwd) })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const sessionKey = started.snapshot.sessionKey

    const readyCapabilities = await waitForReadyCapabilities(() => latest)
    const commandNames = readyCapabilities.commands.map((command) => command.name)
    expect(commandNames).toEqual(expect.arrayContaining(['pipeline', 'scope']))
    const agentNames = readyCapabilities.agents.map((agent) => agent.name)
    expect(agentNames).toEqual(expect.arrayContaining(['plan-agent']))

    store.send(sessionKey, 'Reply with only the word "ok" and stop.')
    const loaded = await waitForLoadedPlugin(() => latest)
    expect(loaded.plugin.kind).toBe('loaded')
    if (loaded.plugin.kind === 'loaded') {
      expect(loaded.plugin.path).toBe(join(cwd, 'plugins', 'port'))
      expect(typeof loaded.plugin.version).toBe('string')
    }
    expect(loaded.components).toEqual({ kind: 'complete' })

    await store.close(sessionKey)
    await store.closeAll()
  }, 60_000)

  // Two hosted sessions route independently, and a second resume of a live id is refused.
  it('#103: two concurrent sessions route independently, and a second resume of a live id is refused', async () => {
    if (!cwd) throw new Error('PORT_LIVE_SDK=1 requires PORT_LIVE_SDK_CWD to name a registered, ready repository')
    const envelopes: { sessionKey: SessionKey }[] = []
    const store = createHostedStore({ ...defaultHostedStoreDeps, onEvent: (envelope) => envelopes.push(envelope) })
    const repoId = 'live-concurrent-acceptance' as RepoId

    const first = await store.start({ repoId, mode: { kind: 'fresh' }, workspace: workspaceFor(cwd) })
    const second = await store.start({ repoId, mode: { kind: 'fresh' }, workspace: workspaceFor(cwd) })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    store.send(first.snapshot.sessionKey, 'Reply with only the word "one" and stop.')
    store.send(second.snapshot.sessionKey, 'Reply with only the word "two" and stop.')

    const firstKey = first.snapshot.sessionKey
    const secondKey = second.snapshot.sessionKey
    const deadline = Date.now() + 30_000
    const bothReady = (): boolean => store.list().filter((snapshot) => snapshot.phase === 'ready' && (snapshot.sessionKey === firstKey || snapshot.sessionKey === secondKey)).length === 2
    while (Date.now() < deadline && !bothReady()) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    expect(bothReady()).toBe(true)

    for (const envelope of envelopes) {
      expect(envelope.sessionKey === firstKey || envelope.sessionKey === secondKey).toBe(true)
    }

    const firstAttached = store.attach(firstKey)
    const firstClaudeSessionId = firstAttached.ok ? firstAttached.snapshot.claudeSessionId : null
    expect(firstClaudeSessionId).not.toBeNull()
    if (firstClaudeSessionId === null) return

    const refused = await store.start({ repoId, mode: { kind: 'resume', sessionId: firstClaudeSessionId }, workspace: workspaceFor(cwd) })
    expect(refused).toEqual({ ok: false, kind: 'already-open', sessionKey: firstKey })

    await store.close(firstKey)
    await store.close(secondKey)
    await store.closeAll()
  }, 60_000)
})

type ReadyCapabilities = Extract<HostedSessionSnapshot['capabilities'], { kind: 'ready' }>

async function waitForReadyCapabilities(latest: () => HostedSessionSnapshot | null): Promise<ReadyCapabilities> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const capabilities = latest()?.capabilities
    if (capabilities?.kind === 'ready') return capabilities
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Timed out waiting for capabilities to reach ready')
}

async function waitForLoadedPlugin(latest: () => HostedSessionSnapshot | null): Promise<ReadyCapabilities> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const capabilities = latest()?.capabilities
    if (capabilities?.kind === 'ready' && capabilities.plugin.kind !== 'unconfirmed') return capabilities
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Timed out waiting for the plugin load to be confirmed')
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Polls the latest snapshot until it carries a pending permission, or throws after a bounded wait. */
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
