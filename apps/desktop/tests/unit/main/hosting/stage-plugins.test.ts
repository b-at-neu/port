import { describe, expect, it } from 'vitest'
import { pathOps } from '@/main/platform/paths'
import { readStageDisabledPlugins, userOnlyPlugins } from '@/main/sessions/hosting/stage-plugins'
import type { FileResult } from '@/types/platform'

describe('userOnlyPlugins', () => {
  it('keeps a user plugin the repository also enables and drops one it does not', () => {
    expect(userOnlyPlugins({ 'port@port': true, 'posthog@posthog': true }, [{ 'port@port': true }])).toEqual(['posthog@posthog'])
  })

  it('treats a version constraint as enabled and false as off, on either side', () => {
    expect(userOnlyPlugins({ 'a@m': ['1.x'], 'b@m': false, 'c@m': true }, [{ 'c@m': false }])).toEqual(['a@m', 'c@m'])
  })

  it('reads anything that is not an object as no plugins', () => {
    expect(userOnlyPlugins(undefined, [])).toEqual([])
    expect(userOnlyPlugins(['a@m'], [])).toEqual([])
    expect(userOnlyPlugins({ 'a@m': true }, [null, 'x'])).toEqual(['a@m'])
  })
})

describe('readStageDisabledPlugins', () => {
  it('reads user settings from the Claude home and repository settings from the stage worktree', async () => {
    const files: Record<string, unknown> = {
      [pathOps.join('/home/.claude', 'settings.json')]: { enabledPlugins: { 'port@port': true, 'superpowers@official': true, 'posthog@posthog': true } },
      [pathOps.join('/wt', '.claude', 'settings.json')]: { enabledPlugins: { 'port@port': true } },
      [pathOps.join('/wt', '.claude', 'settings.local.json')]: { enabledPlugins: { 'superpowers@official': true } },
    }
    const readJsonFile = <T,>(path: string): Promise<FileResult<T>> =>
      Promise.resolve(path in files ? { ok: true, value: files[path] as T } : { ok: false, kind: 'not-found', message: `ENOENT ${path}` })
    await expect(readStageDisabledPlugins('/wt', { readJsonFile, claudeHome: '/home/.claude' })).resolves.toEqual(['posthog@posthog'])
  })

  it('turns nothing off when no settings file can be read', async () => {
    const readJsonFile = <T,>(path: string): Promise<FileResult<T>> => Promise.resolve({ ok: false, kind: 'not-found', message: `ENOENT ${path}` })
    await expect(readStageDisabledPlugins('/wt', { readJsonFile, claudeHome: '/home/.claude' })).resolves.toEqual([])
  })
})
