// One directory to one RepositoryEntry — pure given its injected `git` runner, so tests need no real repository.
import { basename } from 'node:path'
import { pathOps } from '../platform/paths'
import { readJsonFile, statPath } from '../platform/files'
import { resolveVocabulary } from '../../shared/labels/vocabulary'
import type { RepoDiagnostic, RepoId, RepoProblem, RepositoryEntry, ResolvedRepoConfig, SchemaViolation } from '../../shared/repos'
import { currentBranch, permissionsState, refsCarryingConfig } from './harness'
import type { GitRunner } from './harness'
import { resolveEffectiveConfig } from './effective'
import type { PortResolved } from './effective'
import { CONFIG_DEFAULTS, validateConfig } from './schema'

export interface InspectDeps {
  readonly git: GitRunner
}

const CONFIG_RELATIVE_SEGMENTS = ['.claude', 'port.config.json'] as const

function toRepoId(root: string): RepoId {
  // Documented cast: main is the only place either brand is minted from a real path.
  return pathOps.pathKey(root) as unknown as RepoId
}

function problemEntry(root: string, problem: RepoProblem, diagnostics: readonly RepoDiagnostic[] = []): RepositoryEntry {
  return { id: toRepoId(root), path: root, displayName: basename(root), problem, diagnostics }
}

/** Also used by `addRepository`, so a subdirectory and its root register as one entry. */
export async function resolveGitRoot(git: GitRunner, cwd: string): Promise<{ readonly ok: true; readonly root: string } | { readonly ok: false }> {
  const result = await git(['rev-parse', '--show-toplevel'], cwd)
  if (!result.ok) return { ok: false }
  const trimmed = result.stdout.replace(/\r?\n$/, '')
  return { ok: true, root: pathOps.toNative(trimmed) }
}

function isRepoViolation(violation: SchemaViolation): boolean {
  return violation.path === '/repo' || violation.message.includes("'repo'")
}

interface LooseConfig {
  readonly repo?: unknown
  readonly labels?: Readonly<Record<string, unknown>>
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

export async function inspectRepository(path: string, deps: InspectDeps): Promise<RepositoryEntry> {
  const dirCheck = await statPath(path)
  if (!dirCheck.ok || dirCheck.value.kind !== 'directory') {
    return problemEntry(path, { kind: 'directory-missing' })
  }

  const rootResult = await resolveGitRoot(deps.git, path)
  if (!rootResult.ok) {
    return problemEntry(path, { kind: 'not-a-git-repository' })
  }
  const root = rootResult.root

  const configPath = pathOps.join(root, ...CONFIG_RELATIVE_SEGMENTS)
  const configResult = await readJsonFile<unknown>(configPath)

  if (!configResult.ok) {
    if (configResult.kind === 'not-found') {
      const branch = await currentBranch(deps.git, root)
      const currentBranchLabel = branch.kind === 'branch' ? branch.name : branch.kind === 'detached' ? branch.sha : 'unknown'
      const refs = await refsCarryingConfig(deps.git, root)
      const diagnostics: RepoDiagnostic[] = refs.ok ? [] : [{ kind: 'git-unavailable' }]
      return problemEntry(
        root,
        { kind: 'not-port-managed', carriedBy: refs.ok ? refs.refs : [], currentBranch: currentBranchLabel },
        diagnostics,
      )
    }
    if (configResult.kind === 'unparseable') {
      return problemEntry(root, { kind: 'config-malformed', message: configResult.message })
    }
    return problemEntry(root, { kind: 'config-unreadable', reason: configResult.kind, message: configResult.message })
  }

  const { violations } = validateConfig(configResult.value)
  const repoViolations = violations.filter(isRepoViolation)
  const cfg = asLooseConfig(configResult.value)
  const repoUsable = typeof cfg.repo === 'string' && repoViolations.length === 0

  const branchDiagnostics: RepoDiagnostic[] = []
  const branchInfo = await currentBranch(deps.git, root)
  if (branchInfo.kind === 'unavailable') {
    branchDiagnostics.push({ kind: 'git-unavailable' })
  }

  if (!repoUsable) {
    return problemEntry(root, { kind: 'config-invalid', violations: repoViolations.length > 0 ? repoViolations : violations }, branchDiagnostics)
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
  const effective = await resolveEffectiveConfig(root, portResolved, cfg.labels ?? {})
  if (!effective.ok) {
    return problemEntry(root, effective.problem, branchDiagnostics)
  }

  const vocabulary = resolveVocabulary({ labels: cfg.labels, modules: effective.modules, overrides: effective.labelOverrides })

  const config: ResolvedRepoConfig = {
    repo,
    owner: owner ?? '',
    name: name ?? '',
    branches: effective.branches,
    models: effective.models,
    modules: effective.modules,
    reviewCycleCap: effective.reviewCycleCap,
    vocabulary,
    commands,
    concurrency: effective.concurrency,
    sessionRequiredPaths: effective.sessionRequiredPaths,
    checkDispositions: effective.checkDispositions,
    overrides: effective.applied,
  }

  const diagnostics: RepoDiagnostic[] = [...branchDiagnostics]
  if (branchInfo.kind === 'detached') {
    diagnostics.push({ kind: 'detached-head', sha: branchInfo.sha })
  } else if (branchInfo.kind === 'branch' && branchInfo.name !== effective.branches.integration) {
    diagnostics.push({ kind: 'off-integration-branch', branch: branchInfo.name, integration: effective.branches.integration })
  }

  const permissions = await permissionsState(root)
  if (permissions === 'missing') diagnostics.push({ kind: 'permissions-missing' })
  else if (permissions === 'empty') diagnostics.push({ kind: 'permissions-empty' })

  if (nonRepoViolations.length > 0) {
    diagnostics.push({ kind: 'schema-violations', violations: nonRepoViolations })
  }

  for (const refused of effective.refused) {
    diagnostics.push({ kind: 'override-refused', path: refused.path, line: refused.line, reason: refused.reason })
  }

  return { id: toRepoId(root), path: root, displayName: repo, status: 'ready', config, diagnostics }
}
