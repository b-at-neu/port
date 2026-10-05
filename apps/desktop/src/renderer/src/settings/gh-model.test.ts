import { describe, expect, it } from 'vitest'
import { ghStatusModel } from './gh-model'

describe('ghStatusModel', () => {
  it('signed-in is a success pill', () => {
    const model = ghStatusModel({ kind: 'signed-in', checkedAt: '2026-01-01T00:00:00.000Z' })
    expect(model.pillStatus).toBe('success')
    expect(model.pillLabel).toBe('Signed in')
  })

  it('signed-out is a danger pill naming the fix', () => {
    const model = ghStatusModel({ kind: 'signed-out', checkedAt: '2026-01-01T00:00:00.000Z' })
    expect(model.pillStatus).toBe('danger')
    expect(model.pillLabel).toBe('Signed out')
    expect(model.body).toContain('gh auth login')
  })

  it('missing is a danger pill naming installation', () => {
    const model = ghStatusModel({ kind: 'missing', checkedAt: '2026-01-01T00:00:00.000Z' })
    expect(model.pillStatus).toBe('danger')
    expect(model.pillLabel).toBe('Not installed')
    expect(model.body).toContain('PATH')
  })

  it('unknown is an idle pill carrying the failure message', () => {
    const model = ghStatusModel({ kind: 'unknown', message: 'boom', checkedAt: '2026-01-01T00:00:00.000Z' })
    expect(model.pillStatus).toBe('idle')
    expect(model.pillLabel).toBe("Couldn't check")
    expect(model.body).toContain('boom')
  })
})
