import { describe, expect, it } from 'vitest'
import { createPathOps } from '@/main/platform/paths'
import { bundledSdkPackageDir, resolveClaudeExecutable } from '@/main/sessions/runtime/locate'
import type { WhichResult } from '@/types/platform'
import { fakeWhich } from '../../../support/fake-platform'

const posixOps = createPathOps('posix', { home: '/home/operator' })
const win32Ops = createPathOps('win32', { home: 'C:\\Users\\operator' })

describe('bundledSdkPackageDir', () => {
  it('finds the main package directory on posix', () => {
    const path = '/repo/node_modules/@anthropic-ai/claude-agent-sdk/claude'
    expect(bundledSdkPackageDir(path, posixOps)).toBe('/repo/node_modules/@anthropic-ai/claude-agent-sdk')
  })

  it('finds a per-platform binary package directory on posix', () => {
    const path = '/repo/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'
    expect(bundledSdkPackageDir(path, posixOps)).toBe('/repo/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64')
  })

  it('finds a musl per-platform binary package directory', () => {
    const path = '/repo/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude'
    expect(bundledSdkPackageDir(path, posixOps)).toBe('/repo/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl')
  })

  it('finds the package directory on win32', () => {
    const path = 'C:\\repo\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe'
    expect(bundledSdkPackageDir(path, win32Ops)).toBe('C:\\repo\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64')
  })

  it('a real operator install returns null', () => {
    expect(bundledSdkPackageDir('/home/operator/.local/bin/claude', posixOps)).toBeNull()
  })

  it('a sibling directory sharing the same string prefix is not a false match', () => {
    const path = '/repo/node_modules/@anthropic-ai/claude-agent-sdk-extra-tool/claude'
    expect(bundledSdkPackageDir(path, posixOps)).toBeNull()
  })

  it('a claude-agent-sdk-shaped directory outside the @anthropic-ai scope is not a match', () => {
    const path = '/repo/node_modules/some-other-scope/claude-agent-sdk-linux-x64/claude'
    expect(bundledSdkPackageDir(path, posixOps)).toBeNull()
  })
})

describe('resolveClaudeExecutable', () => {
  const BUNDLED = '/repo/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'

  it.each<{ readonly name: string; readonly which: WhichResult; readonly expected: unknown }>([
    { name: 'returns not-found when which cannot resolve claude', which: { ok: false, kind: 'not-found', command: 'claude', searched: ['/usr/bin/claude'] }, expected: { ok: false, kind: 'not-found', searched: ['/usr/bin/claude'] } },
    { name: 'returns ok for a real operator install', which: { ok: true, path: '/home/operator/.local/bin/claude' }, expected: { ok: true, path: '/home/operator/.local/bin/claude' } },
    { name: 'refuses the SDK bundled binary as bundled-fallback', which: { ok: true, path: BUNDLED }, expected: { ok: false, kind: 'bundled-fallback', path: BUNDLED } },
  ])('$name', async ({ which, expected }) => {
    await expect(resolveClaudeExecutable({ which: fakeWhich(() => Promise.resolve(which)) })).resolves.toEqual(expected)
  })
})
