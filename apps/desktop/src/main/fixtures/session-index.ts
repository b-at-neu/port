// Fixture mode's canned session:index. Offsets line up with the stage histories seeded in `./board`.
import type { SessionIndexEntry } from '@/types/session-index'
import type { StageTag } from '@/types/stage-session'
import { WIDGETS_ID } from '@/main/fixtures/repos'

const WORKTREES = '/home/you/src/widgets/.claude/worktrees'

interface IndexSeed {
  readonly id: string
  readonly tag: StageTag
  readonly title: string
  readonly branch: string | null
  readonly startedMinutesAgo: number
  readonly endedMinutesAgo: number | null
  readonly costUsd: number
}

const SEEDS: readonly IndexSeed[] = [
  { id: 'fixture-session-plan-38', tag: { agent: 'plan', number: 38, kind: 'issue', trigger: 'ready' }, title: '#38 retry failed webhook deliveries', branch: null, startedMinutesAgo: 52, endedMinutesAgo: 40, costUsd: 0.31 },
  { id: 'fixture-session-impl-38', tag: { agent: 'impl', number: 38, kind: 'issue', trigger: 'planApproved' }, title: '#38 retry failed webhook deliveries', branch: '38-retry-webhooks', startedMinutesAgo: 2, endedMinutesAgo: null, costUsd: 0.42 },
  { id: 'fixture-session-plan-46', tag: { agent: 'plan', number: 46, kind: 'issue', trigger: 'ready' }, title: '#46 show the last sync time in the header', branch: null, startedMinutesAgo: 172, endedMinutesAgo: 161, costUsd: 0.58 },
  { id: 'fixture-session-impl-46', tag: { agent: 'impl', number: 46, kind: 'issue', trigger: 'planApproved' }, title: '#46 show the last sync time in the header', branch: '46-last-sync-time', startedMinutesAgo: 148, endedMinutesAgo: 92, costUsd: 1.84 },
  { id: 'fixture-session-review-47', tag: { agent: 'review', number: 47, kind: 'pull-request', trigger: 'readyForReview' }, title: 'PR#47 show the last sync time in the header', branch: '46-last-sync-time', startedMinutesAgo: 85, endedMinutesAgo: 62, costUsd: 0.77 },
  { id: 'fixture-session-revise-47', tag: { agent: 'revise', number: 47, kind: 'pull-request', trigger: 'needsRevision' }, title: 'PR#47 show the last sync time in the header', branch: '46-last-sync-time', startedMinutesAgo: 58, endedMinutesAgo: 32, costUsd: 0.96 },
]

export function fixtureSessionIndex(now: Date): readonly SessionIndexEntry[] {
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString()
  return SEEDS.map((seed) => ({
    claudeSessionId: seed.id,
    repoId: WIDGETS_ID,
    cwd: `${WORKTREES}/session-${seed.id}`,
    branch: seed.branch,
    title: seed.title,
    stage: seed.tag,
    startedAt: at(seed.startedMinutesAgo),
    endedAt: seed.endedMinutesAgo === null ? null : at(seed.endedMinutesAgo),
    costUsd: seed.costUsd,
    operatorJoinedAt: null,
  }))
}
