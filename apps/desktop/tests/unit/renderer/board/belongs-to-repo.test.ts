import { describe, expect, it } from 'vitest'
import type { NeedsYouItem } from '@/types/board'
import type { RepoId } from '@/utils/repos'
import { belongsToRepo, needsYouCount, repoNeedsYou } from '@/renderer/board/needs-you'

const id = (value: string) => value as RepoId

const usageLimit = { kind: 'usage-limit', repoId: null, entries: [{ repoId: id('repo-a') }, { repoId: id('repo-b') }] } as unknown as NeedsYouItem
const planReview = { kind: 'plan-review', repoId: id('repo-a') } as unknown as NeedsYouItem

describe('belongsToRepo', () => {
  it('puts a usage-limit item in every repository with an entry in it', () => {
    expect(belongsToRepo(usageLimit, id('repo-a'))).toBe(true)
    expect(belongsToRepo(usageLimit, id('repo-b'))).toBe(true)
    expect(belongsToRepo(usageLimit, id('repo-c'))).toBe(false)
  })

  it('matches every other kind on its own repoId', () => {
    expect(belongsToRepo(planReview, id('repo-a'))).toBe(true)
    expect(belongsToRepo(planReview, id('repo-b'))).toBe(false)
  })
})

describe('repoNeedsYou with a usage-limit item', () => {
  it('counts it in each repository it names, so a repo count matches its filtered screen', () => {
    const items = [usageLimit, planReview]
    expect(repoNeedsYou(items, id('repo-a'))).toBe(2)
    expect(repoNeedsYou(items, id('repo-b'))).toBe(1)
    expect(needsYouCount(items)).toBe(2)
  })
})
