import { describe, expect, it, vi } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { SetRunStateResult } from '@/types/dispatch'
import { resolveDispatchControl } from '@/main/dispatch/resolve'
import { pathOps } from '@/main/platform/paths'
import { dispatchContext, type DispatchContextOptions } from '../../../support/context'

const REPO_ID = 'repo-a' as RepoId
const COCKPIT = pathOps.join('/repo', '.agents', 'cockpit.json')
const NOT_MANAGED = { id: REPO_ID, path: '/repo', displayName: 'o/a', problem: { kind: 'directory-missing' as const }, diagnostics: [] }

function standingDown(standDown = vi.fn(() => Promise.resolve(false))): NonNullable<DispatchContextOptions['live']> {
  return { dispatcher: { stopFor: () => Promise.resolve(false), standDown } } as unknown as NonNullable<DispatchContextOptions['live']>
}

function control(options: DispatchContextOptions = {}) {
  return dispatchContext({ runState: 'paused', live: standingDown(), ...options })
}

async function failingWrite(failure: Extract<SetRunStateResult, { readonly ok: false }>) {
  const ctx = await control()
  vi.spyOn(ctx.stores.runStates, 'set').mockResolvedValue(failure)
  return ctx
}

describe('resolveDispatchControl — validation', () => {
  it('rejects a repoId naming no registered repository', async () => {
    const ctx = await control({ repositories: [] })
    await expect(resolveDispatchControl(ctx, { command: 'run', repoId: REPO_ID })).rejects.toThrow("found no repository registered with id 'repo-a'")
  })
})

describe('resolveDispatchControl — run', () => {
  it('takes ownership, sets dispatching, refreshes once, and reports the new run state', async () => {
    const ctx = await control()
    const result = await resolveDispatchControl(ctx, { command: 'run', repoId: REPO_ID })
    expect(result).toMatchObject({ ok: true, command: 'run', repoId: REPO_ID, runState: { repoId: REPO_ID, state: 'dispatching' } })
    expect(await ctx.fs.readText(COCKPIT)).toMatchObject({ ok: true, value: expect.stringMatching(/"owner": "app"/) as unknown })
    expect(ctx.watcher.refresh).toHaveBeenCalledTimes(1)
    expect(ctx.watcher.refresh).toHaveBeenCalledWith({ repoId: REPO_ID })
  })

  it('is refused outright when the write fails, and never refreshes', async () => {
    const ctx = await failingWrite({ ok: false, reason: 'unwritable', message: 'disk full' })
    const result = await resolveDispatchControl(ctx, { command: 'run', repoId: REPO_ID })
    expect(result).toEqual({ ok: false, command: 'run', repoId: REPO_ID, reason: 'unwritable', message: 'disk full', path: ctx.stores.runStates.path })
    expect(ctx.watcher.refresh).not.toHaveBeenCalled()
  })

  it('refuses with no run-state write at all when the record names the terminal cockpit', async () => {
    const ctx = await control({ owner: 'unreadable' })
    const result = await resolveDispatchControl(ctx, { command: 'run', repoId: REPO_ID })
    expect(result).toMatchObject({ ok: false, command: 'run', repoId: REPO_ID, reason: 'ownership-unreadable', path: COCKPIT })
    expect(ctx.stores.runStates.current(REPO_ID).state).toBe('paused')
    expect(ctx.watcher.refresh).not.toHaveBeenCalled()
  })

  it('skips taking ownership for a repository with no ready config, and still sets run state', async () => {
    const ctx = await control({ repositories: [NOT_MANAGED] })
    const result = await resolveDispatchControl(ctx, { command: 'run', repoId: REPO_ID })
    expect(result.ok).toBe(true)
    expect(await ctx.fs.exists(COCKPIT)).toBe(false)
  })
})

describe('resolveDispatchControl — drain', () => {
  it('sets draining and reports persisted true on a clean write', async () => {
    const ctx = await control()
    const result = await resolveDispatchControl(ctx, { command: 'drain', repoId: REPO_ID })
    expect(result).toMatchObject({ ok: true, command: 'drain', runState: { state: 'draining' }, persisted: true })
  })

  it('reports persisted false when the write fails but the store is readable, never refused', async () => {
    const ctx = await failingWrite({ ok: false, reason: 'unwritable', message: 'disk full' })
    const result = await resolveDispatchControl(ctx, { command: 'drain', repoId: REPO_ID })
    expect(result).toMatchObject({ ok: true, command: 'drain', persisted: false })
  })

  it('is refused outright when the store is unreadable', async () => {
    const ctx = await failingWrite({ ok: false, reason: 'unreadable', message: "can't read" })
    const result = await resolveDispatchControl(ctx, { command: 'drain', repoId: REPO_ID })
    expect(result).toEqual({ ok: false, command: 'drain', repoId: REPO_ID, reason: 'unreadable', message: "can't read", path: ctx.stores.runStates.path })
  })
})

describe('resolveDispatchControl — pause', () => {
  it('halts the one repository, releases ownership, refreshes once, and reports the new run state', async () => {
    const standDown = vi.fn(() => Promise.resolve(false))
    const ctx = await control({ owner: 'app', runState: 'dispatching', live: standingDown(standDown) })
    const result = await resolveDispatchControl(ctx, { command: 'pause', repoId: REPO_ID })
    expect(standDown).toHaveBeenCalledWith(REPO_ID)
    expect(result).toMatchObject({ ok: true, command: 'pause', runState: { state: 'paused' }, report: { kind: 'completed', items: [] }, released: true })
    expect(ctx.watcher.refresh).toHaveBeenCalledTimes(1)
    expect(ctx.watcher.refresh).toHaveBeenCalledWith({ repoId: REPO_ID })
  })

  it('reports released: false without throwing when the release itself fails', async () => {
    const ctx = await control({ owner: 'app' })
    vi.spyOn(ctx.fs, 'remove').mockResolvedValue({ ok: false, kind: 'io', message: 'nope' })
    const result = await resolveDispatchControl(ctx, { command: 'pause', repoId: REPO_ID })
    expect(result).toMatchObject({ ok: true, command: 'pause', released: false })
  })
})
