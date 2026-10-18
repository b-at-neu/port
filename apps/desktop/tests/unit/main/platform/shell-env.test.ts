import { describe, expect, it } from 'vitest'
import { applyLoginShellPath, mergePath, parseSentinelPath, probeLoginShellPath, shouldProbeShell } from '@/main/platform/shell-env'
import type { CommandResult } from '@/types/platform'

const BASE_ENV = { SHELL: '/bin/bash', PATH: '/usr/bin' }

describe('shouldProbeShell', () => {
  it('skips on win32', () => {
    expect(shouldProbeShell({ platform: 'win32', env: BASE_ENV, isPackagedFixtureOrE2E: false })).toBe('win32')
  })

  it('skips when SHELL is unset', () => {
    expect(shouldProbeShell({ platform: 'linux', env: {}, isPackagedFixtureOrE2E: false })).toBe('no-shell')
  })

  it('skips when SHELL is relative', () => {
    expect(shouldProbeShell({ platform: 'linux', env: { SHELL: 'bash' }, isPackagedFixtureOrE2E: false })).toBe('relative-shell')
  })

  it('skips when TERM is set — a terminal launch already has a complete environment', () => {
    expect(shouldProbeShell({ platform: 'linux', env: { ...BASE_ENV, TERM: 'xterm-256color' }, isPackagedFixtureOrE2E: false })).toBe('has-term')
  })

  it('skips in fixture or e2e mode', () => {
    expect(shouldProbeShell({ platform: 'linux', env: BASE_ENV, isPackagedFixtureOrE2E: true })).toBe('fixture-or-e2e')
  })

  it('probes a desktop-like launch — absolute SHELL, no TERM, not fixture/e2e', () => {
    expect(shouldProbeShell({ platform: 'linux', env: BASE_ENV, isPackagedFixtureOrE2E: false })).toBeNull()
  })
})

describe('parseSentinelPath', () => {
  it('reads the text between the last BEGIN and the following END', () => {
    expect(parseSentinelPath('__PORT_PATH_BEGIN__/usr/bin:/bin__PORT_PATH_END__')).toBe('/usr/bin:/bin')
  })

  it('ignores rc-file noise printed before and after the sentinels', () => {
    const stdout = 'Welcome!\n__PORT_PATH_BEGIN__/usr/bin__PORT_PATH_END__\nbye'
    expect(parseSentinelPath(stdout)).toBe('/usr/bin')
  })

  it('returns null when END is missing', () => {
    expect(parseSentinelPath('__PORT_PATH_BEGIN__/usr/bin')).toBeNull()
  })

  it('returns null when BEGIN is missing', () => {
    expect(parseSentinelPath('/usr/bin__PORT_PATH_END__')).toBeNull()
  })

  it('returns an empty string for an empty PATH rather than null', () => {
    expect(parseSentinelPath('__PORT_PATH_BEGIN____PORT_PATH_END__')).toBe('')
  })
})

describe('mergePath', () => {
  it('puts login entries first, then inherited entries not already present', () => {
    expect(mergePath('/a:/b', '/b:/c', ':')).toBe('/a:/b:/c')
  })

  it('preserves order otherwise and drops empty segments', () => {
    expect(mergePath('/a::/b', ':/c:', ':')).toBe('/a:/b:/c')
  })

  it('uses the given delimiter', () => {
    expect(mergePath('C:\\a;C:\\b', 'C:\\b;C:\\c', ';')).toBe('C:\\a;C:\\b;C:\\c')
  })
})

function ok(stdout: string): CommandResult {
  return { ok: true, stdout, stderr: '' }
}

describe('probeLoginShellPath', () => {
  it('returns the parsed PATH on success', async () => {
    const result = await probeLoginShellPath({
      shell: '/bin/bash',
      env: { HOME: '/home/u' },
      run: () => Promise.resolve(ok('__PORT_PATH_BEGIN__/usr/bin__PORT_PATH_END__')),
    })
    expect(result).toEqual({ ok: true, path: '/usr/bin' })
  })

  it('maps a timeout result to the timeout reason', async () => {
    const result = await probeLoginShellPath({
      shell: '/bin/bash',
      env: {},
      run: () => Promise.resolve({ ok: false, kind: 'timeout', timeoutMs: 5_000, stderr: '' }),
    })
    expect(result).toEqual({ ok: false, reason: 'timeout' })
  })

  it('maps a nonzero exit to the nonzero reason', async () => {
    const result = await probeLoginShellPath({
      shell: '/bin/bash',
      env: {},
      run: () => Promise.resolve({ ok: false, kind: 'nonzero', code: 1, stdout: '', stderr: 'boom' }),
    })
    expect(result).toEqual({ ok: false, reason: 'nonzero' })
  })

  it('reports no-sentinels when the sentinels never appear', async () => {
    const result = await probeLoginShellPath({ shell: '/bin/bash', env: {}, run: () => Promise.resolve(ok('nothing useful')) })
    expect(result).toEqual({ ok: false, reason: 'no-sentinels' })
  })

  it('reports empty-path when PATH resolved empty', async () => {
    const result = await probeLoginShellPath({
      shell: '/bin/bash',
      env: {},
      run: () => Promise.resolve(ok('__PORT_PATH_BEGIN____PORT_PATH_END__')),
    })
    expect(result).toEqual({ ok: false, reason: 'empty-path' })
  })
})

describe('applyLoginShellPath', () => {
  it('keeps the inherited PATH and warns on a timeout', async () => {
    const env: NodeJS.ProcessEnv = { ...BASE_ENV }
    await applyLoginShellPath({
      platform: 'linux',
      env,
      isPackagedFixtureOrE2E: false,
      run: () => Promise.resolve({ ok: false, kind: 'timeout', timeoutMs: 5_000, stderr: '' }),
    })
    expect(env.PATH).toBe('/usr/bin')
  })

  it('keeps the inherited PATH on a nonzero exit', async () => {
    const env: NodeJS.ProcessEnv = { ...BASE_ENV }
    await applyLoginShellPath({
      platform: 'linux',
      env,
      isPackagedFixtureOrE2E: false,
      run: () => Promise.resolve({ ok: false, kind: 'nonzero', code: 1, stdout: '', stderr: '' }),
    })
    expect(env.PATH).toBe('/usr/bin')
  })

  it('sets the merged PATH on success', async () => {
    const env: NodeJS.ProcessEnv = { ...BASE_ENV }
    await applyLoginShellPath({
      platform: 'linux',
      env,
      isPackagedFixtureOrE2E: false,
      run: () => Promise.resolve(ok('__PORT_PATH_BEGIN__/home/u/.nvm/bin__PORT_PATH_END__')),
    })
    expect(env.PATH).toBe('/home/u/.nvm/bin:/usr/bin')
  })

  it('never throws when run rejects', async () => {
    const env: NodeJS.ProcessEnv = { ...BASE_ENV }
    await expect(
      applyLoginShellPath({
        platform: 'linux',
        env,
        isPackagedFixtureOrE2E: false,
        run: () => Promise.reject(new Error('spawn exploded')),
      }),
    ).resolves.toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })

  it('does nothing when the skip check says to skip', async () => {
    const env: NodeJS.ProcessEnv = { ...BASE_ENV, TERM: 'xterm' }
    let ran = false
    await applyLoginShellPath({
      platform: 'linux',
      env,
      isPackagedFixtureOrE2E: false,
      run: () => {
        ran = true
        return Promise.resolve(ok('__PORT_PATH_BEGIN__/x__PORT_PATH_END__'))
      },
    })
    expect(ran).toBe(false)
    expect(env.PATH).toBe('/usr/bin')
  })
})
