// Pure Overview view-model: folds a ready repository's config with the
// board's own `BoardSnapshot` into the Sources, Labels, Config sections.
import type { BoardSnapshot, RepositoryHealth, SourceKind } from '@/types/board'
import { SOURCE_KINDS } from '@/types/board'
import type { ModuleFlagName, OverviewModuleFlag } from '@/types/repositories'
import type { DisplayKey } from '@/utils/labels/display'
import type { LabelKey, LabelSource, VocabularyProblem, VocabularyVerdict } from '@/utils/labels/vocabulary'
import type { AppliedOverride, RepoId, ResolvedRepoConfig } from '@/utils/repos'
import { stageNameOfKey } from '@/renderer/lib/ticket-view'

interface OverviewSourceSection {
  readonly kind: SourceKind
  readonly health: RepositoryHealth[SourceKind]
}

interface OverviewLabelRow {
  readonly name: string
  readonly key: string
  readonly roleDisplay: string
  readonly source: LabelSource
  readonly present: boolean | null
}

interface OverviewLabels {
  readonly appOnly: boolean
  readonly verdict: VocabularyVerdict
  readonly unverifiedReason: string | undefined
  readonly problems: readonly VocabularyProblem[]
  readonly rows: readonly OverviewLabelRow[]
}

interface OverviewHealth {
  readonly sources: readonly OverviewSourceSection[] | null
  readonly rateLimit: { readonly remaining: number; readonly resetAt: string } | null
  readonly labels: OverviewLabels | null
  readonly modules: readonly OverviewModuleFlag[]
  readonly overrides: readonly AppliedOverride[]
}

/** Keeps `utils/labels/labels.json`'s own declaration order, the same
 *  order `types/actions.ts`'s `MODULE_LABELS` iterates. */
const MODULE_FLAG_NAMES: readonly ModuleFlagName[] = ['approvalGate', 'release', 'scope']

function roleDisplayFor(key: LabelKey): string {
  const name = stageNameOfKey(key)
  if (name !== null) return name
  if (key === 'marker') return 'Marker'
  if (key === 'prOpened') return 'PR opened'
  return 'Auto-plan'
}

const DISPLAY_ROLE_NAMES: Readonly<Record<DisplayKey, string>> = {
  port: 'Marker',
  needsYou: 'Needs you',
  planning: 'Planning',
  implementing: 'Implementing',
  reviewing: 'Reviewing',
  revising: 'Revising',
  approved: 'Done',
}

/** An app-only repository lists the seven labels the app shows; any other lists its 17 stage labels. */
function rowsOf(config: ResolvedRepoConfig): readonly Omit<OverviewLabelRow, 'present'>[] {
  if (config.appOnly === true && config.displayVocabulary !== undefined) {
    return config.displayVocabulary.labels.map((label) => ({ name: label.name, key: label.key, roleDisplay: DISPLAY_ROLE_NAMES[label.key], source: label.source }))
  }
  return config.vocabulary.labels.map((label) => ({ name: label.name, key: label.key, roleDisplay: roleDisplayFor(label.key), source: label.source }))
}

export function overviewHealth(config: ResolvedRepoConfig, repoId: RepoId, snapshot: BoardSnapshot | undefined): OverviewHealth {
  const health = snapshot?.health.find((h) => h.repoId === repoId) ?? null
  const state = snapshot?.state.repositories.find((r) => r.ok && r.repoId === repoId) ?? null
  const repoState = state !== null && state.ok ? state : null

  const sources: readonly OverviewSourceSection[] | null = health === null ? null : SOURCE_KINDS.map((kind) => ({ kind, health: health[kind] }))

  const rateLimit = repoState !== null ? { remaining: repoState.rateLimit.remaining, resetAt: repoState.rateLimit.resetAt } : null

  const labels: OverviewLabels | null =
    repoState === null
      ? null
      : {
          appOnly: config.appOnly === true,
          verdict: repoState.vocabulary.verdict,
          unverifiedReason: repoState.vocabulary.unverifiedReason,
          problems: repoState.vocabulary.problems,
          rows: rowsOf(config).map((row) => ({
            ...row,
            present: repoState.vocabulary.verdict === 'unverified' ? null : repoState.vocabulary.present.includes(row.name),
          })),
        }

  const modules: readonly OverviewModuleFlag[] = MODULE_FLAG_NAMES.map((name) => ({ name, on: config.modules[name] }))

  return { sources, rateLimit, labels, modules, overrides: config.overrides }
}
