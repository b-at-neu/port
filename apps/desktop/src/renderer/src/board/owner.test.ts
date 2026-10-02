// Covers the line's pure copy function — `buildOwnerLine` itself needs a
// DOM, which this workspace's vitest config does not provide (`environment:
// 'node'`, no jsdom/happy-dom installed), the same gap every other DOM
// builder under `renderer/src/board/` already has (see `tick.test.ts`'s own
// header).
import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../../shared/repos'
import type { RepoDispatchStatus } from '../../../shared/dispatch/types'
import { ownerLineCopy } from './owner'

const REPO_ID = 'repo-a' as RepoId

function status(overrides: Partial<RepoDispatchStatus> = {}): RepoDispatchStatus {
  return { repoId: REPO_ID, owner: 'app', state: { kind: 'idle' }, draining: false, claudeSessionId: null, claimedAt: null, ...overrides }
}

describe('ownerLineCopy', () => {
  it('nobody — the unreadable-claim line', () => {
    expect(ownerLineCopy(status({ owner: 'nobody' }))).toContain("can't be read")
  })

  it('cockpit — the standard-pipeline line', () => {
    expect(ownerLineCopy(status({ owner: 'cockpit' }))).toContain('your terminal cockpit dispatches here')
  })

  it('app, idle, never claimed — no "claimed" clause', () => {
    expect(ownerLineCopy(status())).toBe('▶ Dispatch: this app · nothing to dispatch.')
  })

  it('app, idle, claimed — the claimed-time clause', () => {
    const line = ownerLineCopy(status({ claimedAt: '2026-01-01T14:02:00Z' }))
    expect(line).toContain('claimed')
    expect(line).toContain('nothing to dispatch')
  })

  it('app, active — names every sent/started record and the newest time', () => {
    const line = ownerLineCopy(
      status({
        state: {
          kind: 'active',
          recent: [
            { agent: 'plan', number: 105, kind: 'issue', state: 'started', at: '2026-01-01T14:00:00Z' },
            { agent: 'impl', number: 52, kind: 'issue', state: 'sent', at: '2026-01-01T14:07:00Z' },
          ],
        },
      }),
    )
    expect(line).toContain('plan #105')
    expect(line).toContain('impl #52')
  })

  it('app, active — a not-started record is never named', () => {
    const line = ownerLineCopy(status({ state: { kind: 'active', recent: [{ agent: 'impl', number: 52, kind: 'issue', state: 'not-started', at: '2026-01-01T14:07:00Z' }] } }))
    expect(line).toBe('▶ Dispatch: this app · nothing to dispatch.')
  })

  it('refused — budget-unported', () => {
    expect(ownerLineCopy(status({ state: { kind: 'refused', reason: 'budget-unported' } }))).toContain('commands.budget is set')
  })

  it('dispatcher-failed — at-capacity names the limit', () => {
    expect(ownerLineCopy(status({ state: { kind: 'dispatcher-failed', reason: 'at-capacity', limit: 4 } }))).toContain('4 hosted sessions')
  })

  it('dispatcher-failed — plugin', () => {
    expect(ownerLineCopy(status({ state: { kind: 'dispatcher-failed', reason: 'plugin' } }))).toContain("plugin didn't load")
  })

  it('agents-missing names the dropped agent', () => {
    expect(ownerLineCopy(status({ state: { kind: 'agents-missing', agent: 'impl' } }))).toContain('port:impl-agent')
  })
})
