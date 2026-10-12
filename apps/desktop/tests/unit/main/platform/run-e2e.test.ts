import { afterEach, describe, expect, it } from 'vitest'
import { runCommand, setE2ERoute } from '@/main/platform/run'
import type { RunCommandOptions, Spawner } from '@/types/platform'

afterEach(() => {
  setE2ERoute(null)
})

describe('runCommand — E2E routing', () => {
  it('routes a known command through process.execPath to the fake, with the command as the first arg', async () => {
    setE2ERoute({ fake: '/sandbox/fake/cli.mjs' })

    let seenPath: string | undefined
    let seenArgs: readonly string[] | undefined
    let seenEnv: NodeJS.ProcessEnv | undefined
    const spawner: Spawner = (absPath, args, params) => {
      seenPath = absPath
      seenArgs = args
      seenEnv = params.env
      return Promise.resolve({ stdout: 'ok', stderr: '' })
    }

    const result = await runCommand('gh', ['issue', 'edit', '1'], { spawner })

    expect(result).toEqual({ ok: true, stdout: 'ok', stderr: '' })
    expect(seenPath).toBe(process.execPath)
    expect(seenArgs).toEqual(['/sandbox/fake/cli.mjs', 'gh', 'issue', 'edit', '1'])
    expect(seenEnv?.['ELECTRON_RUN_AS_NODE']).toBe('1')
  })

  it('never consults `resolve`/`which` while routed', async () => {
    setE2ERoute({ fake: '/sandbox/fake/cli.mjs' })

    let resolveCalled = false
    const spawner: Spawner = () => Promise.resolve({ stdout: '', stderr: '' })
    const resolve: NonNullable<RunCommandOptions['resolve']> = () => {
      resolveCalled = true
      return Promise.resolve({ ok: true, path: '/usr/bin/git' })
    }

    await runCommand('git', ['status'], { spawner, resolve })

    expect(resolveCalled).toBe(false)
  })

  it('leaves routing untouched when E2E mode is off', async () => {
    let seenPath: string | undefined
    const spawner: Spawner = (absPath) => {
      seenPath = absPath
      return Promise.resolve({ stdout: '', stderr: '' })
    }
    const resolve = () => Promise.resolve({ ok: true as const, path: '/usr/bin/git' })

    await runCommand('git', ['status'], { spawner, resolve })

    expect(seenPath).toBe('/usr/bin/git')
  })
})
