// Built the same way `main/registry/inspect.ts` resolves a real one, never a hand-retyped config shape. `acme/widgets` is `ready`; `acme/legacy-site` is `config-invalid`.
import { CONFIG_DEFAULTS } from '../registry/schema'
import { resolveVocabulary, verifyVocabulary } from '../../shared/labels/vocabulary'
import type { VocabularyReport } from '../../shared/labels/vocabulary'
import type { RepoId, RepositoryEntry, ResolvedRepoConfig } from '../../shared/repos'

export const WIDGETS_ID = 'fixture-acme-widgets' as RepoId
export const LEGACY_SITE_ID = 'fixture-acme-legacy-site' as RepoId
export const GADGETS_ID = 'fixture-acme-gadgets' as RepoId

const WIDGETS_VOCABULARY = resolveVocabulary({ modules: CONFIG_DEFAULTS.modules })

const WIDGETS_CONFIG: ResolvedRepoConfig = {
  repo: 'acme/widgets',
  owner: 'acme',
  name: 'widgets',
  branches: CONFIG_DEFAULTS.branches,
  models: CONFIG_DEFAULTS.models,
  modules: CONFIG_DEFAULTS.modules,
  reviewCycleCap: CONFIG_DEFAULTS.reviewCycleCap,
  vocabulary: WIDGETS_VOCABULARY,
  // A real commands.worktrees, not CONFIG_DEFAULTS' own null, so the Worktrees tab has an Inspect button.
  commands: { ...CONFIG_DEFAULTS.commands, worktrees: 'node plugins/port/bin/worktrees.mjs' },
  concurrency: CONFIG_DEFAULTS.concurrency,
  checkDispositions: {},
  overrides: [],
}

/** The fixture's own GitHub read always carries every label it resolved, so `verifyVocabulary` reports `verified`. */
export const WIDGETS_VOCABULARY_REPORT: VocabularyReport = verifyVocabulary(WIDGETS_VOCABULARY, { ok: true, names: WIDGETS_VOCABULARY.labels.map((label) => label.name) })

// `labels.ready` overridden to `'queued'` via a CLAUDE.md override — its own
// GitHub read carries no vocabulary label at all, so it resolves mis-resolved.
const GADGETS_OVERRIDES = { ready: 'queued' } as const
const GADGETS_VOCABULARY = resolveVocabulary({ modules: CONFIG_DEFAULTS.modules, overrides: GADGETS_OVERRIDES })

export const GADGETS_VOCABULARY_REPORT: VocabularyReport = verifyVocabulary(GADGETS_VOCABULARY, { ok: true, names: [] })

const GADGETS_CONFIG: ResolvedRepoConfig = {
  repo: 'acme/gadgets',
  owner: 'acme',
  name: 'gadgets',
  branches: CONFIG_DEFAULTS.branches,
  models: CONFIG_DEFAULTS.models,
  modules: CONFIG_DEFAULTS.modules,
  reviewCycleCap: CONFIG_DEFAULTS.reviewCycleCap,
  vocabulary: GADGETS_VOCABULARY,
  commands: { ...CONFIG_DEFAULTS.commands, worktrees: 'node plugins/port/bin/worktrees.mjs' },
  concurrency: CONFIG_DEFAULTS.concurrency,
  checkDispositions: {},
  overrides: [{ path: 'labels.ready', value: 'queued', reason: 'CLAUDE.md port-overrides', portDefault: 'ready', source: 'CLAUDE.md' }],
}

export const FIXTURE_REPOSITORIES: readonly RepositoryEntry[] = [
  {
    id: WIDGETS_ID,
    path: '/home/you/src/widgets',
    displayName: 'acme/widgets',
    status: 'ready',
    config: WIDGETS_CONFIG,
    diagnostics: [],
  },
  {
    id: LEGACY_SITE_ID,
    path: '/home/you/src/legacy-site',
    displayName: 'legacy-site',
    problem: {
      kind: 'config-invalid',
      violations: [{ path: '/repo', message: 'must match pattern "^[^/]+/[^/]+$"' }],
    },
    diagnostics: [],
  },
  {
    id: GADGETS_ID,
    path: '/home/you/src/gadgets',
    displayName: 'acme/gadgets',
    status: 'ready',
    config: GADGETS_CONFIG,
    diagnostics: [],
  },
]
