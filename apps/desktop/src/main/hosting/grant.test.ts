import { describe, expect, it } from 'vitest'
import { narrowSessionGrant } from './grant'
import type { PermissionUpdate } from './sdk'

describe('narrowSessionGrant', () => {
  it('returns null for undefined or empty suggestions', () => {
    expect(narrowSessionGrant(undefined)).toBeNull()
    expect(narrowSessionGrant([])).toBeNull()
  })

  it('keeps an allow addRules suggestion, rewriting destination to session', () => {
    const suggestions: PermissionUpdate[] = [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' },
    ]
    const grant = narrowSessionGrant(suggestions)
    expect(grant).not.toBeNull()
    expect(grant?.updates).toEqual([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' }])
    expect(grant?.summary).toEqual([{ kind: 'rule', toolName: 'Bash', ruleContent: 'npm test:*' }])
  })

  it('a rule with no ruleContent summarises with null', () => {
    const suggestions: PermissionUpdate[] = [{ type: 'addRules', rules: [{ toolName: 'WebSearch' }], behavior: 'allow', destination: 'userSettings' }]
    const grant = narrowSessionGrant(suggestions)
    expect(grant?.summary).toEqual([{ kind: 'rule', toolName: 'WebSearch', ruleContent: null }])
  })

  it('drops an addRules suggestion whose behavior is not allow', () => {
    const suggestions: PermissionUpdate[] = [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' }]
    expect(narrowSessionGrant(suggestions)).toBeNull()
  })

  it('keeps addDirectories, rewriting destination to session', () => {
    const suggestions: PermissionUpdate[] = [{ type: 'addDirectories', directories: ['/home/operator/Downloads'], destination: 'projectSettings' }]
    const grant = narrowSessionGrant(suggestions)
    expect(grant?.updates).toEqual([{ type: 'addDirectories', directories: ['/home/operator/Downloads'], destination: 'session' }])
    expect(grant?.summary).toEqual([{ kind: 'directory', path: '/home/operator/Downloads' }])
  })

  it('keeps setMode acceptEdits, rewriting destination to session', () => {
    const suggestions: PermissionUpdate[] = [{ type: 'setMode', mode: 'acceptEdits', destination: 'cliArg' }]
    const grant = narrowSessionGrant(suggestions)
    expect(grant?.updates).toEqual([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }])
    expect(grant?.summary).toEqual([{ kind: 'accept-edits' }])
  })

  it('drops setMode for any mode other than acceptEdits, including bypassPermissions', () => {
    for (const mode of ['default', 'bypassPermissions', 'plan', 'dontAsk', 'auto'] as const) {
      const suggestions: PermissionUpdate[] = [{ type: 'setMode', mode, destination: 'session' }]
      expect(narrowSessionGrant(suggestions)).toBeNull()
    }
  })

  it('drops replaceRules, removeRules, and removeDirectories entirely', () => {
    const suggestions: PermissionUpdate[] = [
      { type: 'replaceRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
      { type: 'removeRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
      { type: 'removeDirectories', directories: ['/tmp'], destination: 'session' },
    ]
    expect(narrowSessionGrant(suggestions)).toBeNull()
  })

  it('a mixed list keeps only the allowlisted kinds', () => {
    const suggestions: PermissionUpdate[] = [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch:*' }], behavior: 'allow', destination: 'localSettings' },
      { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
      { type: 'addDirectories', directories: ['/repo'], destination: 'session' },
    ]
    const grant = narrowSessionGrant(suggestions)
    expect(grant?.updates).toHaveLength(2)
    expect(grant?.summary).toEqual([
      { kind: 'rule', toolName: 'Bash', ruleContent: 'touch:*' },
      { kind: 'directory', path: '/repo' },
    ])
  })
})
