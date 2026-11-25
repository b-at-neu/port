import { describe, expect, it } from 'vitest'
import { pathOps } from '@/main/platform/paths'
import { readStageDisabledPlugins, userOnlyPlugins } from '@/main/sessions/hosting/stage-plugins'
import { createFakeFs } from '../../../support/fake-platform'

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
    const fs = createFakeFs()
    await fs.writeJsonAtomic(pathOps.join('/home/.claude', 'settings.json'), { enabledPlugins: { 'port@port': true, 'superpowers@official': true, 'posthog@posthog': true } })
    await fs.writeJsonAtomic(pathOps.join('/wt', '.claude', 'settings.json'), { enabledPlugins: { 'port@port': true } })
    await fs.writeJsonAtomic(pathOps.join('/wt', '.claude', 'settings.local.json'), { enabledPlugins: { 'superpowers@official': true } })
    await expect(readStageDisabledPlugins({ fs, claudeHome: '/home/.claude' }, '/wt')).resolves.toEqual(['posthog@posthog'])
  })

  it('turns nothing off when no settings file can be read', async () => {
    await expect(readStageDisabledPlugins({ fs: createFakeFs(), claudeHome: '/home/.claude' }, '/wt')).resolves.toEqual([])
  })
})
