import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { allowRule } from './allowlist'
import type { FileResult } from '../platform/files'

function fakeFs(initial: Record<string, unknown>) {
  const files = new Map<string, unknown>(Object.entries(initial))
  function readJson<T>(path: string): Promise<FileResult<T>> {
    if (!files.has(path)) return Promise.resolve({ ok: false, kind: 'not-found', message: 'missing' })
    const value = files.get(path)
    if (value === 'UNPARSEABLE') return Promise.resolve({ ok: false, kind: 'unparseable', message: 'bad json' })
    return Promise.resolve({ ok: true, value: value as T })
  }
  function writeJsonAtomic(path: string, value: unknown): Promise<FileResult<void>> {
    files.set(path, value)
    return Promise.resolve({ ok: true, value: undefined })
  }
  return { files, readJson, writeJsonAtomic }
}

const settingsPath = join('/repo', '.claude', 'settings.json')
const configPath = join('/repo', '.claude', 'port.config.json')

describe('allowRule', () => {
  it('appends the rule to both files', async () => {
    const fs = fakeFs({ [settingsPath]: { permissions: { allow: [] } }, [configPath]: { extraAllow: [] } })
    const result = await allowRule({ root: '/repo', rule: 'Bash(git status *)', readJson: fs.readJson, writeJsonAtomic: fs.writeJsonAtomic })
    expect(result).toEqual({ kind: 'ok' })
    expect(fs.files.get(settingsPath)).toEqual({ permissions: { allow: ['Bash(git status *)'] } })
    expect(fs.files.get(configPath)).toEqual({ extraAllow: ['Bash(git status *)'] })
  })

  it('reports already-allowed when the rule is already in both files', async () => {
    const fs = fakeFs({ [settingsPath]: { permissions: { allow: ['Bash(git status *)'] } }, [configPath]: { extraAllow: ['Bash(git status *)'] } })
    const result = await allowRule({ root: '/repo', rule: 'Bash(git status *)', readJson: fs.readJson, writeJsonAtomic: fs.writeJsonAtomic })
    expect(result).toEqual({ kind: 'already-allowed' })
  })

  it('creates a missing settings.json', async () => {
    const fs = fakeFs({ [configPath]: { extraAllow: [] } })
    const result = await allowRule({ root: '/repo', rule: 'Bash(pnpm *)', readJson: fs.readJson, writeJsonAtomic: fs.writeJsonAtomic })
    expect(result).toEqual({ kind: 'ok' })
    expect(fs.files.get(settingsPath)).toEqual({ permissions: { allow: ['Bash(pnpm *)'] } })
  })

  it('writes nothing when settings.json is unparseable', async () => {
    const fs = fakeFs({ [settingsPath]: 'UNPARSEABLE', [configPath]: { extraAllow: [] } })
    const result = await allowRule({ root: '/repo', rule: 'Bash(pnpm *)', readJson: fs.readJson, writeJsonAtomic: fs.writeJsonAtomic })
    expect(result.kind).toBe('write-failed')
    expect(fs.files.get(configPath)).toEqual({ extraAllow: [] })
  })

  it('reports write-failed naming port.config.json after settings succeeds', async () => {
    const fs = fakeFs({ [settingsPath]: { permissions: { allow: [] } }, [configPath]: 'UNPARSEABLE' })
    const result = await allowRule({ root: '/repo', rule: 'Bash(pnpm *)', readJson: fs.readJson, writeJsonAtomic: fs.writeJsonAtomic })
    expect(result.kind).toBe('write-failed')
    if (result.kind === 'write-failed') expect(result.file).toBe('port.config.json')
  })

  it('refuses an unrestricted rule without writing', async () => {
    const fs = fakeFs({ [settingsPath]: { permissions: { allow: [] } }, [configPath]: { extraAllow: [] } })
    const result = await allowRule({ root: '/repo', rule: 'Bash', readJson: fs.readJson, writeJsonAtomic: fs.writeJsonAtomic })
    expect(result).toEqual({ kind: 'invalid-rule', reason: 'unrestricted' })
    expect(fs.files.get(settingsPath)).toEqual({ permissions: { allow: [] } })
  })
})
