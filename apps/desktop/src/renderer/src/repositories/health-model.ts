// Pure Overview view-model: folds a ready repository's config with the
// board's own `BoardSnapshot` into the Sources, Labels, Config sections.
import type { BoardSnapshot, RepositoryHealth, SourceKind } from '../../../shared/board/types'
import { SOURCE_KINDS } from '../../../shared/board/types'
import type { LabelKey, LabelSource, VocabularyProblem, VocabularyVerdict } from '../../../shared/labels/vocabulary'
import type { AppliedOverride, RepoId, ResolvedRepoConfig } from '../../../shared/repos'
import { PHASE_NAMES } from '../lib/phase'

export interface OverviewSourceSection {
  readonly kind: SourceKind
  readonly health: RepositoryHealth[SourceKind]
}

export interface OverviewLabelRow {
  readonly name: string
  readonly key: LabelKey
  readonly roleDisplay: string
  readonly source: LabelSource
  readonly present: boolean | null
}

export interface OverviewLabels {
  readonly verdict: VocabularyVerdict
  readonly unverifiedReason: string | undefined
  readonly problems: readonly VocabularyProblem[]
  readonly rows: readonly OverviewLabelRow[]
}

export type ModuleFlagName = keyof ResolvedRepoConfig['modules']

export interface OverviewModuleFlag {
  readonly name: ModuleFlagName
  readonly on: boolean
}

export interface OverviewHealth {
  readonly sources: readonly OverviewSourceSection[] | null
  readonly rateLimit: { readonly remaining: number; readonly resetAt: string } | null
  readonly labels: OverviewLabels | null
  readonly modules: readonly OverviewModuleFlag[]
  readonly overrides: readonly AppliedOverride[]
}

/** Keeps `plugins/port/data/labels.json`'s own declaration order, the same
 *  order `shared/actions/types.ts`'s `MODULE_LABELS` iterates. */
const MODULE_FLAG_NAMES: readonly ModuleFlagName[] = ['approvalGate', 'release', 'scope']

function roleDisplayFor(key: LabelKey): string {
  const name = PHASE_NAMES[key]
  if (name !== null) return name
  return key === 'marker' ? 'Marker' : 'Auto-plan'
}

export function overviewHealth(config: ResolvedRepoConfig, repoId: RepoId, snapshot: BoardSnapshot | undefined, _now: Date): OverviewHealth {
  const health = snapshot?.health.find((h) => h.repoId === repoId) ?? null
  const state = snapshot?.state.repositories.find((r) => r.ok && r.repoId === repoId) ?? null
  const repoState = state !== null && state.ok ? state : null

  const sources: readonly OverviewSourceSection[] | null = health === null ? null : SOURCE_KINDS.map((kind) => ({ kind, health: health[kind] }))

  const rateLimit = repoState !== null ? { remaining: repoState.rateLimit.remaining, resetAt: repoState.rateLimit.resetAt } : null

  const labels: OverviewLabels | null =
    repoState === null
      ? null
      : {
          verdict: repoState.vocabulary.verdict,
          unverifiedReason: repoState.vocabulary.unverifiedReason,
          problems: repoState.vocabulary.problems,
          rows: config.vocabulary.labels.map((label) => ({
            name: label.name,
            key: label.key,
            roleDisplay: roleDisplayFor(label.key),
            source: label.source,
            present: repoState.vocabulary.verdict === 'unverified' ? null : repoState.vocabulary.present.includes(label.name),
          })),
        }

  const modules: readonly OverviewModuleFlag[] = MODULE_FLAG_NAMES.map((name) => ({ name, on: config.modules[name] }))

  return { sources, rateLimit, labels, modules, overrides: config.overrides }
}
