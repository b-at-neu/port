// Fixture mode's own canned registry (#317) — two entries, built the same
// way `main/registry/inspect.ts` resolves a real one: `CONFIG_DEFAULTS` plus
// `resolveVocabulary`, never a hand-retyped config shape. `acme/widgets` is
// `ready`; `acme/legacy-site` is `config-invalid`, with one violation, so the
// Repositories screen's fixture shows both a healthy and a broken card.
// Display paths are plain strings — main is the minting side, so `as RepoId`
// is the one cast this file needs.
import { CONFIG_DEFAULTS } from '../registry/schema'
import { resolveVocabulary, verifyVocabulary } from '../../shared/labels/vocabulary'
import type { VocabularyReport } from '../../shared/labels/vocabulary'
import type { RepoId, RepositoryEntry, ResolvedRepoConfig } from '../../shared/repos'

export const WIDGETS_ID = 'fixture-acme-widgets' as RepoId
export const LEGACY_SITE_ID = 'fixture-acme-legacy-site' as RepoId

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
  commands: CONFIG_DEFAULTS.commands,
  concurrency: CONFIG_DEFAULTS.concurrency,
  checkDispositions: {},
  overrides: [],
}

/** Every vocabulary label reads back present — the fixture's own GitHub read
 *  always carries every label it resolved, so `verifyVocabulary` reports
 *  `verified` rather than a fixture needing its own "missing label" case. */
export const WIDGETS_VOCABULARY_REPORT: VocabularyReport = verifyVocabulary(WIDGETS_VOCABULARY, { ok: true, names: WIDGETS_VOCABULARY.labels.map((label) => label.name) })

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
]
