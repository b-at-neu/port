import { describe, expect, it } from 'vitest'
import { ghStatusModel } from '@/renderer/settings/gh-model'

describe('ghStatusModel', () => {
  it('signed-in is a success pill', () => {
    const model = ghStatusModel({ kind: 'signed-in', checkedAt: '2026-01-01T00:00:00.000Z', account: null, scopes: null })
    expect(model.pillStatus).toBe('success')
    expect(model.scopesLine).toBeNull()
  })

  it('signed-in names the account and lists the scopes when they were read', () => {
    const model = ghStatusModel({ kind: 'signed-in', checkedAt: '2026-01-01T00:00:00.000Z', account: 'octo', scopes: ['repo', 'read:org', 'workflow'] })
    expect(model.body).toContain('octo')
    expect(model.scopesLine).toContain('repo, read:org, workflow')
  })

  it('an empty scope list still gets a line, never a blank one', () => {
    const line = ghStatusModel({ kind: 'signed-in', checkedAt: '2026-01-01T00:00:00.000Z', account: 'octo', scopes: [] }).scopesLine
    expect(line).not.toBeNull()
    expect(line?.trim()).not.toBe('')
  })

  it.each(['signed-out', 'missing'] as const)('%s is a danger pill', (kind) => {
    expect(ghStatusModel({ kind, checkedAt: '2026-01-01T00:00:00.000Z' }).pillStatus).toBe('danger')
  })

  it('unknown is an idle pill carrying the failure message', () => {
    const model = ghStatusModel({ kind: 'unknown', message: 'boom', checkedAt: '2026-01-01T00:00:00.000Z' })
    expect(model.pillStatus).toBe('idle')
    expect(model.body).toContain('boom')
  })
})
