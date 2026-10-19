import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { NeedsYouItem } from '@/types/board'
import type { SessionKey } from '@/types/hosting'

const navigate = vi.hoisted(() => vi.fn())

vi.mock('@/renderer/router/router', () => ({ router: { navigate } }))
vi.mock('@/renderer/gate/controller', () => ({ openReviewDialog: vi.fn() }))
vi.mock('@/renderer/decision/controller', () => ({ openDecision: vi.fn() }))
vi.mock('@/renderer/needs-you/allow-dialog', () => ({ openAllowDialog: vi.fn() }))
vi.mock('@/renderer/needs-you/restart-dialog', () => ({ openRestartDialog: vi.fn() }))
vi.mock('@/renderer/needs-you/force-dispatch-dialog', () => ({ openForceDispatchDialog: vi.fn() }))
vi.mock('@/renderer/data/invoke', () => ({ invoke: vi.fn() }))

const { actionFor, runSecondaryAction } = await import('@/renderer/needs-you/actions')

function stageBlocked(): NeedsYouItem {
  return { kind: 'stage-blocked', repoId: 'repo-a' as RepoId, repo: 'o/a', number: 51, title: 't', url: null, at: null, matchedRow: null, sessionKey: 'hosted-51' as SessionKey, text: 'BLOCKED: x' }
}

describe('actionFor — stage-blocked', () => {
  it('answers inline, with Open session as its secondary', () => {
    expect(actionFor(stageBlocked())).toEqual({ label: 'Unblock', kind: 'answer', disabledReason: null, secondaryLabel: 'Open session' })
  })
})

describe('runSecondaryAction — stage-blocked', () => {
  beforeEach(() => navigate.mockClear())

  it('opens the live session', () => {
    runSecondaryAction(stageBlocked(), { onToast: () => undefined })
    expect(navigate).toHaveBeenCalledWith({ to: '/session', search: { key: 'hosted-51' } })
  })
})
