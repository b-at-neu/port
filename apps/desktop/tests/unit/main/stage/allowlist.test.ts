import { describe, expect, it } from 'vitest'
import { CONFIG_PATH, SETTINGS_PATH, mergeRule } from '@/main/stage/allowlist'

const settings = (allow: string[], extra: Record<string, unknown> = {}) => JSON.stringify({ ...extra, permissions: { deny: ['x'], allow } })
const config = (extraAllow: string[]) => JSON.stringify({ repo: 'o/r', extraAllow })

describe('mergeRule', () => {
  it('returns both files with the rule appended, keeping every other key and the order', () => {
    const result = mergeRule({ settingsText: settings(['Bash(a *)'], { env: { A: '1' } }), configText: config(['Bash(b *)']), rule: 'Bash(git status *)' })
    expect(result.kind).toBe('files')
    if (result.kind !== 'files') return
    expect(result.files.map((f) => f.path)).toEqual([SETTINGS_PATH, CONFIG_PATH])
    expect(JSON.parse(result.files[0]?.content ?? '')).toEqual({ env: { A: '1' }, permissions: { deny: ['x'], allow: ['Bash(a *)', 'Bash(git status *)'] } })
    expect(JSON.parse(result.files[1]?.content ?? '')).toEqual({ repo: 'o/r', extraAllow: ['Bash(b *)', 'Bash(git status *)'] })
    expect(result.files[0]?.content.endsWith('}\n')).toBe(true)
  })

  it('lists only the file that lacks the rule', () => {
    const result = mergeRule({ settingsText: settings(['Bash(pnpm *)']), configText: config([]), rule: 'Bash(pnpm *)' })
    expect(result.kind === 'files' && result.files.map((f) => f.path)).toEqual([CONFIG_PATH])
  })

  it('reports already-allowed when both files hold the rule', () => {
    expect(mergeRule({ settingsText: settings(['Bash(pnpm *)']), configText: config(['Bash(pnpm *)']), rule: 'Bash(pnpm *)' })).toEqual({ kind: 'already-allowed' })
  })

  it('treats a missing settings.json as an empty allowlist', () => {
    const result = mergeRule({ settingsText: null, configText: config([]), rule: 'Bash(pnpm *)' })
    expect(result.kind === 'files' && JSON.parse(result.files[0]?.content ?? '')).toEqual({ permissions: { allow: ['Bash(pnpm *)'] } })
  })

  it('names the unparseable file', () => {
    expect(mergeRule({ settingsText: '{', configText: config([]), rule: 'Bash(pnpm *)' })).toEqual({ kind: 'unparseable', file: SETTINGS_PATH })
    expect(mergeRule({ settingsText: null, configText: '[]', rule: 'Bash(pnpm *)' })).toEqual({ kind: 'unparseable', file: CONFIG_PATH })
  })

  it('refuses an unrestricted rule', () => {
    expect(mergeRule({ settingsText: settings([]), configText: config([]), rule: 'Bash' })).toEqual({ kind: 'invalid-rule', reason: 'unrestricted' })
  })
})
