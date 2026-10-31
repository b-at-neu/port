// `ownershipBannerFor` — the Board's two owner banners and the owners that get none.
import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { RepoDispatchStatus } from '@/types/dispatch'
import { ownershipBannerFor } from '@/renderer/board/owner'

const REPO_ID = 'repo-a' as RepoId

function status(overrides: Partial<RepoDispatchStatus> = {}): RepoDispatchStatus {
  return { repoId: REPO_ID, owner: 'app', state: { kind: 'idle' }, runState: 'dispatching', ownedSince: null, unreadableMessage: null, budget: null, observed: [], denials: [], interrupted: [], ...overrides }
}

describe('ownershipBannerFor', () => {
  it('unreadable is an error naming the repository, the reason, and that neither side runs it', () => {
    const banner = ownershipBannerFor(status({ owner: 'unreadable', unreadableMessage: 'invalid JSON' }), 'o/a')
    expect(banner?.kind).toBe('error')
    expect(banner?.takeOver).toBe(false)
    expect(banner?.message).toContain('o/a — .agents/cockpit.json can\'t be read (invalid JSON)')
    expect(banner?.message).toContain('Neither this app nor a terminal cockpit runs this repo')
  })

  it('unreadable falls back to an unknown reason', () => {
    expect(ownershipBannerFor(status({ owner: 'unreadable' }), 'o/a')?.message).toContain('(unknown reason)')
  })

  it('terminal is a notice with Take over', () => {
    expect(ownershipBannerFor(status({ owner: 'terminal' }), 'o/a')).toEqual({
      kind: 'notice',
      message: "Your terminal cockpit runs o/a. This app won't dispatch, answer gates, or write labels there.",
      takeOver: true,
    })
  })

  it('app and none need nothing from the operator', () => {
    expect(ownershipBannerFor(status({ owner: 'app' }), 'o/a')).toBeNull()
    expect(ownershipBannerFor(status({ owner: 'none' }), 'o/a')).toBeNull()
  })
})
