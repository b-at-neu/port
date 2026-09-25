import { describe, expect, it } from 'vitest'
import { createWhich } from './which'

describe('which', () => {
  it('an override env var wins over PATH', async () => {
    const { which } = createWhich()
    const probed: string[] = []
    const result = await which({
      command: 'git',
      env: { PORT_GIT_PATH: '/custom/git', PATH: '/usr/bin' },
      platform: 'linux',
      probe: (candidate) => {
        probed.push(candidate)
        return Promise.resolve(candidate === '/custom/git')
      },
    })
    expect(result).toEqual({ ok: true, path: '/custom/git' })
    expect(probed).toEqual(['/custom/git'])
  })

  it('falls through to PATH when the override misses', async () => {
    const { which } = createWhich()
    const result = await which({
      command: 'git',
      env: { PORT_GIT_PATH: '/custom/git', PATH: '/usr/local/bin:/usr/bin' },
      platform: 'linux',
      probe: (candidate) => Promise.resolve(candidate === '/usr/bin/git'),
    })
    expect(result).toEqual({ ok: true, path: '/usr/bin/git' })
  })

  it('finds a PATH hit', async () => {
    const { which } = createWhich()
    const result = await which({
      command: 'gh',
      env: { PATH: '/opt/tools:/usr/bin' },
      platform: 'linux',
      probe: (candidate) => Promise.resolve(candidate === '/usr/bin/gh'),
    })
    expect(result).toEqual({ ok: true, path: '/usr/bin/gh' })
  })

  it('matches a PATHEXT extension on win32', async () => {
    const { which } = createWhich()
    const result = await which({
      command: 'git',
      env: { PATH: 'C:\\tools', PATHEXT: '.EXE;.CMD' },
      platform: 'win32',
      probe: (candidate) => Promise.resolve(candidate === 'C:\\tools\\git.cmd'),
    })
    expect(result).toEqual({ ok: true, path: 'C:\\tools\\git.cmd' })
  })

  it('reaches the fallback list only after PATH misses', async () => {
    const { which } = createWhich()
    const probed: string[] = []
    const result = await which({
      command: 'gh',
      env: { PATH: '/usr/bin' },
      platform: 'darwin',
      probe: (candidate) => {
        probed.push(candidate)
        return Promise.resolve(candidate === '/opt/homebrew/bin/gh')
      },
    })
    expect(result).toEqual({ ok: true, path: '/opt/homebrew/bin/gh' })
    expect(probed[0]).toBe('/usr/bin/gh')
    expect(probed.at(-1)).toBe('/opt/homebrew/bin/gh')
  })

  it('reports every candidate tried on a miss', async () => {
    const { which } = createWhich()
    const result = await which({
      command: 'git',
      env: { PATH: '/usr/bin' },
      platform: 'linux',
      probe: () => Promise.resolve(false),
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('not-found')
    expect(result.command).toBe('git')
    expect(result.searched).toContain('/usr/bin/git')
    expect(result.searched).toContain('/usr/local/bin/git')
  })

  it('caches a resolved path per instance, never re-probing', async () => {
    const { which } = createWhich()
    let probeCount = 0
    const options = {
      command: 'git',
      env: { PATH: '/usr/bin' },
      platform: 'linux' as const,
      probe: () => {
        probeCount++
        return Promise.resolve(true)
      },
    }
    await which(options)
    await which(options)
    expect(probeCount).toBe(1)
  })

  it('resolves node from the win32 nodejs fallback dir (#86)', async () => {
    const { which } = createWhich()
    const probed: string[] = []
    const result = await which({
      command: 'node',
      env: { PATH: 'C:\\tools' },
      platform: 'win32',
      probe: (candidate) => {
        probed.push(candidate)
        return Promise.resolve(candidate === 'C:\\Program Files\\nodejs\\node.exe')
      },
    })
    expect(result).toEqual({ ok: true, path: 'C:\\Program Files\\nodejs\\node.exe' })
    expect(probed).toContain('C:\\Program Files\\nodejs\\node.exe')
  })

  it('resolves claude from the posix $HOME/.local/bin fallback (#97)', async () => {
    const { which } = createWhich()
    const probed: string[] = []
    const result = await which({
      command: 'claude',
      env: { PATH: '/usr/bin', HOME: '/home/operator' },
      platform: 'linux',
      probe: (candidate) => {
        probed.push(candidate)
        return Promise.resolve(candidate === '/home/operator/.local/bin/claude')
      },
    })
    expect(result).toEqual({ ok: true, path: '/home/operator/.local/bin/claude' })
    expect(probed).toContain('/home/operator/.local/bin/claude')
  })

  it('tries every posix claude fallback before giving up, and never touches os.homedir()', async () => {
    const { which } = createWhich()
    const result = await which({
      command: 'claude',
      env: { PATH: '/usr/bin', HOME: '/home/operator' },
      platform: 'linux',
      probe: () => Promise.resolve(false),
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.searched).toContain('/home/operator/.local/bin/claude')
    expect(result.searched).toContain('/home/operator/.claude/local/claude')
    expect(result.searched).toContain('/home/operator/.bun/bin/claude')
    expect(result.searched).toContain('/home/operator/.npm-global/bin/claude')
  })

  it('a posix claude fallback with no HOME in env contributes no candidates', async () => {
    const { which } = createWhich()
    const result = await which({
      command: 'claude',
      env: { PATH: '/usr/bin' },
      platform: 'linux',
      probe: () => Promise.resolve(false),
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.searched.some((path) => path.includes('.local/bin/claude'))).toBe(false)
  })

  it('resolves claude from the win32 LOCALAPPDATA fallback, simulated from a posix host (#97)', async () => {
    const { which } = createWhich()
    const result = await which({
      command: 'claude',
      env: { PATH: 'C:\\tools', LOCALAPPDATA: 'C:\\Users\\operator\\AppData\\Local' },
      platform: 'win32',
      probe: (candidate) => Promise.resolve(candidate === 'C:\\Users\\operator\\AppData\\Local\\Programs\\claude\\claude.exe'),
    })
    expect(result).toEqual({ ok: true, path: 'C:\\Users\\operator\\AppData\\Local\\Programs\\claude\\claude.exe' })
  })

  it('tries every win32 claude fallback, derived only from the injected env', async () => {
    const { which } = createWhich()
    const result = await which({
      command: 'claude',
      env: {
        PATH: 'C:\\tools',
        LOCALAPPDATA: 'C:\\Users\\operator\\AppData\\Local',
        APPDATA: 'C:\\Users\\operator\\AppData\\Roaming',
        USERPROFILE: 'C:\\Users\\operator',
      },
      platform: 'win32',
      probe: () => Promise.resolve(false),
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.searched.some((path) => path.startsWith('C:\\Users\\operator\\AppData\\Local\\Programs\\claude\\'))).toBe(true)
    expect(result.searched.some((path) => path.startsWith('C:\\Users\\operator\\AppData\\Local\\claude\\'))).toBe(true)
    expect(result.searched.some((path) => path.startsWith('C:\\Users\\operator\\AppData\\Roaming\\npm\\'))).toBe(true)
    expect(result.searched.some((path) => path.startsWith('C:\\Users\\operator\\.local\\bin\\'))).toBe(true)
  })

  it('a fresh createWhich() instance has its own cache', async () => {
    const first = createWhich()
    const second = createWhich()
    let probeCount = 0
    const options = {
      command: 'git',
      env: { PATH: '/usr/bin' },
      platform: 'linux' as const,
      probe: () => {
        probeCount++
        return Promise.resolve(true)
      },
    }
    await first.which(options)
    await second.which(options)
    expect(probeCount).toBe(2)
  })
})
