import { describe, expect, it } from 'vitest'
import { diagnosticCopy, overrideLineCopy, problemCopy, registryBannerCopy, summaryParts } from './copy'
import type { AppliedOverride, ResolvedRepoConfig } from '../../../shared/repos'

function baseConfig(overrides: Partial<ResolvedRepoConfig> = {}): ResolvedRepoConfig {
  return {
    repo: 'o/n',
    owner: 'o',
    name: 'n',
    branches: { integration: 'dev', production: 'main' },
    models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
    modules: { approvalGate: true, release: true, scope: true },
    reviewCycleCap: 5,
    vocabulary: { labels: Array.from({ length: 15 }, () => ({ key: 'ready', name: 'ready', source: 'default', module: 'core', role: 'trigger' })), disabled: [], problems: [] } as never,
    commands: { worktrees: null, budget: null },
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
    checkDispositions: {},
    overrides: [],
    ...overrides,
  }
}

describe('problemCopy', () => {
  it('names the effective-config-unreadable CLAUDE.md case', () => {
    const copy = problemCopy({ kind: 'effective-config-unreadable', file: 'CLAUDE.md', reason: 'permission-denied', message: 'EACCES' })
    expect(copy).toContain("Can't read CLAUDE.md")
    expect(copy).toContain('EACCES')
    expect(copy).toContain('port-overrides block can rename labels and change gates')
  })

  it('names the effective-config-unreadable approval-check.yml case', () => {
    const copy = problemCopy({ kind: 'effective-config-unreadable', file: '.github/workflows/approval-check.yml', reason: 'not-a-file', message: 'EISDIR' })
    expect(copy).toContain("Can't read .github/workflows/approval-check.yml")
    expect(copy).toContain('names the check the approval gate excuses')
  })
})

describe('diagnosticCopy', () => {
  it('names a refused override with its line and reason, and that the port value stands', () => {
    const copy = diagnosticCopy({ kind: 'override-refused', path: 'commands.checks', line: 'commands.checks = node x.ts  # different runner', reason: "'commands.checks' is the permission surface the guard hook allowlists from — never overridable, no exception" })
    expect(copy).toBe(
      "CLAUDE.md override refused: commands.checks = node x.ts  # different runner — 'commands.checks' is the permission surface the guard hook allowlists from — never overridable, no exception. The port value stands.",
    )
  })

  it('names a block-level refusal by its marker line, path null', () => {
    const copy = diagnosticCopy({ kind: 'override-refused', path: null, line: '<!-- port-overrides:begin -->', reason: 'a second port-overrides block was found — only the first is read, never merged' })
    expect(copy).toBe('CLAUDE.md override refused: <!-- port-overrides:begin --> — a second port-overrides block was found — only the first is read, never merged. The port value stands.')
  })
})

function override(overrides: Partial<AppliedOverride> = {}): AppliedOverride {
  return { path: 'reviewCycleCap', value: 3, reason: 'we converge in three or it needs a human', portDefault: 5, source: 'CLAUDE.md', ...overrides }
}

describe('overrideLineCopy', () => {
  it('renders a scalar override', () => {
    expect(overrideLineCopy(override())).toBe('override: reviewCycleCap = 3 (port default: 5) — we converge in three or it needs a human — source: CLAUDE.md')
  })

  it('renders a labels.<key> override', () => {
    expect(overrideLineCopy(override({ path: 'labels.ready', value: 'go', portDefault: 'ready', reason: 'this repo already used "ready" for triage' }))).toBe(
      'override: labels.ready = go (port default: ready) — this repo already used "ready" for triage — source: CLAUDE.md',
    )
  })

  it('renders an append-only override whose port default is an array, comma-joined', () => {
    expect(overrideLineCopy(override({ path: 'sessionRequiredPaths', value: 'infra/**', portDefault: ['CLAUDE.md', '.claude/**'], reason: 'terraform is operator-only here' }))).toBe(
      'override: sessionRequiredPaths = infra/** (port default: CLAUDE.md, .claude/**) — terraform is operator-only here — source: CLAUDE.md',
    )
  })

  it('renders a null port default as none', () => {
    expect(overrideLineCopy(override({ path: 'branches.production', value: null, portDefault: null, reason: 'single branch' }))).toBe('override: branches.production = null (port default: none) — single branch — source: CLAUDE.md')
  })

  it('renders an unset port default as unset, never the literal word undefined', () => {
    expect(overrideLineCopy(override({ portDefault: undefined }))).toContain('(port default: unset)')
  })
})

describe('summaryParts', () => {
  it('shows integration → production for a two-branch repository', () => {
    expect(summaryParts(baseConfig()).join(' · ')).toContain('dev → main')
  })

  it('shows only the integration branch in single-branch mode (production null)', () => {
    const parts = summaryParts(baseConfig({ branches: { integration: 'dev', production: null }, modules: { approvalGate: true, release: false, scope: true } }))
    expect(parts[0]).toBe('dev')
    expect(parts.join(' · ')).not.toContain('→')
  })

  it('drops a module from the summary when it is off', () => {
    const parts = summaryParts(baseConfig({ modules: { approvalGate: true, release: false, scope: true } }))
    expect(parts.join(' · ')).not.toContain('release')
    expect(parts.join(' · ')).toContain('approval gate')
  })
})

describe('registryBannerCopy', () => {
  it('names each reason', () => {
    expect(registryBannerCopy({ path: 'registry.json', reason: 'unreadable' })).toContain("couldn't be read")
    expect(registryBannerCopy({ path: 'registry.json', reason: 'malformed' })).toContain("isn't valid JSON")
    expect(registryBannerCopy({ path: 'registry.json', reason: 'unsupported-version' })).toContain('newer version of Port')
  })
})
