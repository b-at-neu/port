// One directory to one RepositoryEntry — pure given its ctx's `git` and `fs`, so tests need no real repository.
import { pathOps } from '@/main/platform/paths'
import type { Platform } from '@/main/platform'
import { resolveDisplayVocabulary } from '@/utils/labels/display'
import { LABEL_KEYS, resolveVocabulary } from '@/utils/labels/vocabulary'
import type { RepoDiagnostic, RepoId, RepoProblem, RepositoryEntry, ResolvedRepoConfig, SchemaViolation } from '@/utils/repos'
import { defaultRefName, permissionsStateOf, readAtDefaultRef, refsCarryingConfig } from '@/main/repos/config/harness'
import { resolveEffectiveConfig } from '@/main/repos/config/effective'
import type { PortResolved, RefReader } from '@/types/registry'
import { CONFIG_PATH, SETTINGS_PATH } from '@/main/repos/config/paths'
import { CONFIG_DEFAULTS, validateConfig } from '@/main/repos/config/schema'

function toRepoId(root: string): RepoId {
  // Documented cast: main is the only place either brand is minted from a real path.
  return pathOps.pathKey(root) as unknown as RepoId
}

function problemEntry(root: string, problem: RepoProblem, diagnostics: readonly RepoDiagnostic[] = []): RepositoryEntry {
  return { id: toRepoId(root), path: root, displayName: pathOps.basename(root), problem, diagnostics }
}

/** Also used by `addRepository`, so a subdirectory and its root register as one entry. */
export async function resolveGitRoot(ctx: Pick<Platform, 'git'>, cwd: string): Promise<{ readonly ok: true; readonly root: string } | { readonly ok: false }> {
  const result = await ctx.git(['rev-parse', '--show-toplevel'], cwd)
  if (!result.ok) return { ok: false }
  const trimmed = result.stdout.replace(/\r?\n$/, '')
  return { ok: true, root: pathOps.toNative(trimmed) }
}

function isRepoViolation(violation: SchemaViolation): boolean {
  return violation.path === '/repo' || violation.message.includes("'repo'")
}

/** Ajv reports each unknown `labels` property as one `/labels` violation without naming it, so the legacy keys are counted rather than matched by path. */
function foldLegacyLabelViolations(violations: readonly SchemaViolation[], legacyKeyCount: number): readonly SchemaViolation[] {
  let toDrop = legacyKeyCount
  return violations.filter((violation) => {
    if (toDrop === 0 || violation.path !== '/labels' || !violation.message.includes('additional propert')) return true
    toDrop -= 1
    return false
  })
}

interface LooseConfig {
  readonly repo?: unknown
  readonly labels?: Readonly<Record<string, unknown>>
  readonly states?: Readonly<Record<string, unknown>>
  readonly appOnly?: unknown
  readonly branches?: { readonly integration?: unknown; readonly production?: unknown }
  readonly models?: { readonly plan?: unknown; readonly impl?: unknown; readonly review?: unknown; readonly revise?: unknown }
  readonly modules?: {
    readonly approvalGate?: unknown
    readonly release?: unknown
    readonly scope?: unknown
  }
  readonly reviewCycleCap?: unknown
  readonly commands?: { readonly worktrees?: unknown; readonly budget?: unknown }
  readonly concurrency?: { readonly sharedFiles?: unknown; readonly overlapThreshold?: unknown }
  readonly sessionRequiredPaths?: unknown
}

function asLooseConfig(value: unknown): LooseConfig {
  return typeof value === 'object' && value !== null ? value : {}
}

/** Uses `raw` only when present and not violated — a wrong-shaped field must fall back to its default, which `??` alone would not catch. */
function resolveField<T>(raw: unknown, path: string, violatedPaths: ReadonlySet<string>, fallback: T): T {
  if (violatedPaths.has(path)) return fallback
  return raw === undefined ? fallback : (raw as T)
}

export async function inspectRepository(ctx: Pick<Platform, 'git' | 'fs'>, path: string): Promise<RepositoryEntry> {
  const dirCheck = await ctx.fs.stat(path)
  if (!dirCheck.ok || dirCheck.value.kind !== 'directory') {
    return problemEntry(path, { kind: 'directory-missing' })
  }

  const rootResult = await resolveGitRoot(ctx, path)
  if (!rootResult.ok) {
    return problemEntry(path, { kind: 'not-a-git-repository' })
  }
  const root = rootResult.root

  const read: RefReader = (relPath) => readAtDefaultRef(ctx, root, relPath)
  const configRead = await read(CONFIG_PATH)

  if (!configRead.ok) {
    if (configRead.kind === 'ref-unreadable') return problemEntry(root, { kind: 'config-ref-unreadable', message: configRead.message })
    if (configRead.kind === 'not-found') {
      const ref = (await defaultRefName(ctx, root)) ?? 'origin/HEAD'
      const refs = await refsCarryingConfig(ctx, root)
      const diagnostics: RepoDiagnostic[] = refs.ok ? [] : [{ kind: 'git-unavailable' }]
      return problemEntry(root, { kind: 'not-port-managed', carriedBy: refs.ok ? refs.refs : [], ref }, diagnostics)
    }
    return problemEntry(root, { kind: 'config-unreadable', reason: 'io', message: configRead.message })
  }

  let configValue: unknown
  try {
    configValue = JSON.parse(configRead.text)
  } catch (error) {
    return problemEntry(root, { kind: 'config-malformed', message: error instanceof Error ? error.message : String(error) })
  }

  const { violations } = validateConfig(configValue)
  const repoViolations = violations.filter(isRepoViolation)
  const cfg = asLooseConfig(configValue)
  const repoUsable = typeof cfg.repo === 'string' && repoViolations.length === 0

  if (!repoUsable) {
    return problemEntry(root, { kind: 'config-invalid', violations: repoViolations.length > 0 ? repoViolations : violations })
  }

  const repo = cfg.repo
  const [owner, name] = repo.split('/')
  const nonRepoViolations = violations.filter((v) => !isRepoViolation(v))
  const violatedPaths = new Set(nonRepoViolations.map((v) => v.path))

  const branches = {
    integration: resolveField(cfg.branches?.integration, '/branches/integration', violatedPaths, CONFIG_DEFAULTS.branches.integration),
    production: resolveField(cfg.branches?.production, '/branches/production', violatedPaths, CONFIG_DEFAULTS.branches.production),
  }
  const models = {
    plan: resolveField(cfg.models?.plan, '/models/plan', violatedPaths, CONFIG_DEFAULTS.models.plan),
    impl: resolveField(cfg.models?.impl, '/models/impl', violatedPaths, CONFIG_DEFAULTS.models.impl),
    review: resolveField(cfg.models?.review, '/models/review', violatedPaths, CONFIG_DEFAULTS.models.review),
    revise: resolveField(cfg.models?.revise, '/models/revise', violatedPaths, CONFIG_DEFAULTS.models.revise),
  }
  const modules = {
    approvalGate: resolveField(cfg.modules?.approvalGate, '/modules/approvalGate', violatedPaths, CONFIG_DEFAULTS.modules.approvalGate),
    release: resolveField(cfg.modules?.release, '/modules/release', violatedPaths, CONFIG_DEFAULTS.modules.release),
    scope: resolveField(cfg.modules?.scope, '/modules/scope', violatedPaths, CONFIG_DEFAULTS.modules.scope),
  }
  const reviewCycleCap = resolveField(cfg.reviewCycleCap, '/reviewCycleCap', violatedPaths, CONFIG_DEFAULTS.reviewCycleCap)
  const commands = {
    worktrees: resolveField(cfg.commands?.worktrees, '/commands/worktrees', violatedPaths, CONFIG_DEFAULTS.commands.worktrees),
    budget: resolveField(cfg.commands?.budget, '/commands/budget', violatedPaths, CONFIG_DEFAULTS.commands.budget),
  }
  const concurrency = {
    sharedFiles: resolveField(cfg.concurrency?.sharedFiles, '/concurrency/sharedFiles', violatedPaths, CONFIG_DEFAULTS.concurrency.sharedFiles),
    overlapThreshold: resolveField(cfg.concurrency?.overlapThreshold, '/concurrency/overlapThreshold', violatedPaths, CONFIG_DEFAULTS.concurrency.overlapThreshold),
  }
  const sessionRequiredPaths = resolveField(cfg.sessionRequiredPaths, '/sessionRequiredPaths', violatedPaths, CONFIG_DEFAULTS.sessionRequiredPaths)

  // Folds a root CLAUDE.md's port-overrides block over the port-resolved values above — never a second, hand-rolled resolution.
  const portResolved: PortResolved = { branches, models, modules, reviewCycleCap, concurrency, sessionRequiredPaths }
  const appOnly = !violatedPaths.has('/appOnly') && cfg.appOnly === true
  const effective = await resolveEffectiveConfig(read, portResolved, cfg.labels ?? {}, cfg.states ?? {}, appOnly)
  if (!effective.ok) {
    return problemEntry(root, effective.problem)
  }

  // An app-only repository's `labels` holds display keys, which the stage vocabulary has no use for.
  const vocabulary = resolveVocabulary({ labels: appOnly ? {} : cfg.labels, modules: effective.modules, overrides: effective.labelOverrides })
  const displayVocabulary = resolveDisplayVocabulary({ labels: cfg.labels, states: cfg.states, overrides: effective.displayOverrides })

  const config: ResolvedRepoConfig = {
    repo,
    owner: owner ?? '',
    name: name ?? '',
    branches: effective.branches,
    models: effective.models,
    modules: effective.modules,
    reviewCycleCap: effective.reviewCycleCap,
    vocabulary,
    appOnly,
    displayVocabulary,
    commands,
    concurrency: effective.concurrency,
    sessionRequiredPaths: effective.sessionRequiredPaths,
    checkDispositions: effective.checkDispositions,
    overrides: effective.applied,
  }

  const diagnostics: RepoDiagnostic[] = []
  const permissions = permissionsStateOf(await read(SETTINGS_PATH))
  if (permissions === 'missing') diagnostics.push({ kind: 'permissions-missing' })
  else if (permissions === 'empty') diagnostics.push({ kind: 'permissions-empty' })

  const legacyKeys = appOnly ? [] : Object.keys(cfg.labels ?? {}).filter((key) => (LABEL_KEYS as readonly string[]).includes(key))
  const reportedViolations = foldLegacyLabelViolations(nonRepoViolations, legacyKeys.length)
  if (legacyKeys.length > 0) diagnostics.push({ kind: 'legacy-label-overrides', keys: legacyKeys })
  if (reportedViolations.length > 0) {
    diagnostics.push({ kind: 'schema-violations', violations: reportedViolations })
  }

  for (const refused of effective.refused) {
    diagnostics.push({ kind: 'override-refused', path: refused.path, line: refused.line, reason: refused.reason })
  }

  return { id: toRepoId(root), path: root, displayName: repo, status: 'ready', config, diagnostics }
}
