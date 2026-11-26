import { describe, expect, it } from 'vitest'
import { readStagePrompt, stagePromptsDir, writeStagePrompt } from '@/main/sessions/hosting/stage-prompt-store'
import { createFakeFs } from '../../../../support/fake-platform'

const DIR = stagePromptsDir('/data')

describe('the saved stage prompt', () => {
  it('reads back what was written for a session id', async () => {
    const fs = createFakeFs()
    await expect(writeStagePrompt(fs, DIR, 'abc-123', 'the prompt')).resolves.toBeNull()
    await expect(readStagePrompt(fs, DIR, 'abc-123')).resolves.toBe('the prompt')
  })

  it('reads a session that has none as null', async () => {
    await expect(readStagePrompt(createFakeFs(), DIR, 'abc-123')).resolves.toBeNull()
  })

  it.each(['../escape', 'a/b', 'a.b', ''])('refuses to use %j as a path segment', async (id) => {
    const fs = createFakeFs()
    await expect(readStagePrompt(fs, DIR, id)).resolves.toBeNull()
    await expect(writeStagePrompt(fs, DIR, id, 'x')).resolves.toEqual(expect.stringContaining('not a valid file name'))
  })
})
