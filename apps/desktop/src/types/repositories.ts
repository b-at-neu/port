import type { RepoId, ResolvedRepoConfig } from '@/utils/repos'

// The claim dialog's and the Settings runtime section's repo picker shared the same shape under
// two names (#430) — one definition here, used by both.
export interface ReadyRepo {
  readonly id: RepoId
  readonly repo: string
}

export type ModuleFlagName = keyof ResolvedRepoConfig['modules']

export interface OverviewModuleFlag {
  readonly name: ModuleFlagName
  readonly on: boolean
}
