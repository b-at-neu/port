import type { HostedSessionSnapshot } from '@/types/hosting'
import type { StageTag } from '@/types/stage-session'
import type { RepoId } from '@/utils/repos'

/** One app-hosted session's durable history row — kept after the session closes, unlike `hosting.json`'s restore set. */
export interface SessionIndexEntry {
  readonly claudeSessionId: string
  readonly repoId: RepoId | null
  readonly cwd: string
  readonly branch: string | null
  readonly title: string | null
  readonly stage: StageTag | null
  readonly startedAt: string
  readonly endedAt: string | null
  readonly costUsd: number | null
  readonly operatorJoinedAt: string | null
}

export interface SessionIndex {
  load(): Promise<void>
  observe(snapshot: HostedSessionSnapshot): void
  list(): readonly SessionIndexEntry[]
}
