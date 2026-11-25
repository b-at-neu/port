import { resolveVocabulary } from '@/utils/labels/vocabulary'
import type { RepoId, ResolvedRepoConfig } from '@/utils/repos'
import type { ReadyEntry } from '@/types/actions'

/** A resolved repository config at the port defaults. */
export function repoConfig(overrides: Partial<ResolvedRepoConfig> = {}): ResolvedRepoConfig {
  return {
    repo: 'o/a',
    owner: 'o',
    name: 'a',
    branches: { integration: 'dev', production: 'main' },
    commands: { worktrees: null, budget: null },
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
    sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
    checkDispositions: {},
    overrides: [],
    models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
    modules: { approvalGate: true, release: true, scope: true },
    reviewCycleCap: 5,
    vocabulary: resolveVocabulary({}),
    ...overrides,
  }
}

/** A ready repository entry wrapping a resolved config. */
export function readyEntry(overrides: Partial<ReadyEntry> = {}, config: Partial<ResolvedRepoConfig> = {}): ReadyEntry {
  return {
    id: 'repo-a' as RepoId,
    path: '/repo',
    displayName: 'o/a',
    status: 'ready',
    config: repoConfig(config),
    diagnostics: [],
    ...overrides,
  }
}
