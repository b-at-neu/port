import { describe, expect, it } from 'vitest'
import type { PhaseInput } from '@/types/release'
import { BUMP_BRANCH_DIR, bumpBranchName, bumpSubject, releasePrTitle, versionOfBumpBranch, versionOfReleaseTitle } from '@/utils/release/format'
import { resolvePhase } from '@/main/release/state'

const BASE: PhaseInput = {
  moduleEnabled: true,
  production: 'main',
  versionSource: 'package',
  versionFiles: ['package.json'],
  versionCommand: null,
  bumpBranches: [],
  openReleasePr: null,
  lastClosedReleasePr: null,
  publishedTags: new Set(['v0.2.0']),
  integrationVersion: '0.2.1-dev',
  productionVersion: '0.2.0',
  gatherEmpty: false,
}

const PR = { number: 612, url: 'https://github.com/acme/widgets/pull/612', title: 'Release v0.3.0' }

function phase(overrides: Partial<PhaseInput>) {
  return resolvePhase({ ...BASE, ...overrides })
}

describe('resolvePhase guards', () => {
  it('is off when the module is disabled, before any other check', () => {
    expect(phase({ moduleEnabled: false, openReleasePr: PR }).kind).toBe('off')
  })

  it('is single-branch for a null production branch', () => {
    expect(phase({ production: null }).kind).toBe('single-branch')
  })

  it('is misconfigured for package with no version files, but not for tags', () => {
    expect(phase({ versionFiles: [] }).kind).toBe('misconfigured')
    expect(phase({ versionFiles: [], versionSource: 'tags' }).kind).toBe('idle')
  })

  it('needs a terminal when a version command is set', () => {
    expect(phase({ versionCommand: 'npm version {{version}}' }).kind).toBe('needs-terminal')
  })
})

describe('resolvePhase order', () => {
  it('reports two bump branches as a conflict', () => {
    expect(phase({ bumpBranches: [{ name: 'bump/v0.3.0', pr: null }, { name: 'bump/v0.4.0', pr: null }] })).toEqual({ kind: 'conflict', branches: ['bump/v0.3.0', 'bump/v0.4.0'] })
  })

  it('waits on one bump branch, taking its version and carrying both pull request links', () => {
    expect(phase({ bumpBranches: [{ name: 'bump/v0.3.0', pr: { number: 611, url: 'u' } }], openReleasePr: PR })).toEqual({
      kind: 'waiting-bump',
      version: '0.3.0',
      bumpPr: { number: 611, url: 'u' },
      releasePr: { number: 612, url: PR.url },
    })
  })

  it('waits on an open release pull request, reading the version from its title or else the integration version', () => {
    expect(phase({ openReleasePr: PR })).toMatchObject({ kind: 'waiting-merge', version: '0.3.0' })
    expect(phase({ openReleasePr: { ...PR, title: 'renamed' } })).toMatchObject({ kind: 'waiting-merge', version: '0.2.1' })
  })

  it('is ready to publish after a merged release pull request whose version has no release', () => {
    expect(phase({ lastClosedReleasePr: { ...PR, merged: true } })).toEqual({ kind: 'ready-to-publish', version: '0.3.0' })
  })

  it('is not ready to publish once that release exists', () => {
    expect(phase({ lastClosedReleasePr: { ...PR, merged: true }, publishedTags: new Set(['v0.2.0', 'v0.3.0']) }).kind).not.toBe('ready-to-publish')
  })

  it('counts an unreleased production version for package only', () => {
    expect(phase({ productionVersion: '0.3.0' })).toEqual({ kind: 'ready-to-publish', version: '0.3.0' })
    expect(phase({ productionVersion: '0.3.0', versionSource: 'tags' }).kind).toBe('idle')
  })

  it('reports an unmerged closed release pull request as abandoned', () => {
    expect(phase({ lastClosedReleasePr: { ...PR, merged: false } })).toMatchObject({ kind: 'abandoned', version: '0.3.0' })
  })

  it('is bumped when the integration version is clean and differs from production', () => {
    expect(phase({ integrationVersion: '0.3.0' })).toEqual({ kind: 'bumped', version: '0.3.0' })
    expect(phase({ integrationVersion: '0.2.0' }).kind).toBe('idle')
  })

  it('is idle, or nothing-to-release when the gather is empty', () => {
    expect(phase({}).kind).toBe('idle')
    expect(phase({ gatherEmpty: true }).kind).toBe('nothing-to-release')
  })
})

describe('format literals', () => {
  it('round-trips the release title and bump branch', () => {
    expect(releasePrTitle('0.3.0')).toBe('Release v0.3.0')
    expect(versionOfReleaseTitle('Release v0.3.0')).toBe('0.3.0')
    expect(versionOfReleaseTitle('Release 0.3.0')).toBeNull()
    expect(bumpBranchName('0.3.0')).toBe('bump/v0.3.0')
    expect(versionOfBumpBranch('bump/v0.3.0')).toBe('0.3.0')
    expect(BUMP_BRANCH_DIR).toBe('bump/')
    expect(bumpSubject('0.3.0')).toBe('bump version to v0.3.0')
  })
})
