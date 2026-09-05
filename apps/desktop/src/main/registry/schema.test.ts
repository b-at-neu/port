import { describe, expect, it } from 'vitest'
import ownConfig from '../../../../../.claude/port.config.json'
import validAplio from '../../../../../schema/fixtures/valid.aplio.json'
import validMinimal from '../../../../../schema/fixtures/valid.minimal.json'
import validPortfolio from '../../../../../schema/fixtures/valid.portfolio.json'
import invalidBadRepo from '../../../../../schema/fixtures/invalid.bad-repo.json'
import invalidCheckMissingRun from '../../../../../schema/fixtures/invalid.check-missing-run.json'
import invalidMissingRepo from '../../../../../schema/fixtures/invalid.missing-repo.json'
import invalidUnknownKey from '../../../../../schema/fixtures/invalid.unknown-key.json'
import invalidUnknownTracker from '../../../../../schema/fixtures/invalid.unknown-tracker.json'
import { CONFIG_DEFAULTS, validateConfig } from './schema'

describe('validateConfig', () => {
  it('validates this repository own .claude/port.config.json clean', () => {
    expect(validateConfig(ownConfig).violations).toEqual([])
  })

  for (const [name, fixture] of [
    ['valid.aplio.json', validAplio],
    ['valid.minimal.json', validMinimal],
    ['valid.portfolio.json', validPortfolio],
  ] as const) {
    it(`validates ${name} clean`, () => {
      expect(validateConfig(fixture).violations).toEqual([])
    })
  }

  for (const [name, fixture] of [
    ['invalid.bad-repo.json', invalidBadRepo],
    ['invalid.check-missing-run.json', invalidCheckMissingRun],
    ['invalid.missing-repo.json', invalidMissingRepo],
    ['invalid.unknown-key.json', invalidUnknownKey],
    ['invalid.unknown-tracker.json', invalidUnknownTracker],
  ] as const) {
    it(`reports at least one violation with a non-empty path for ${name}`, () => {
      const { violations } = validateConfig(fixture)
      expect(violations.length).toBeGreaterThan(0)
      for (const violation of violations) {
        expect(violation.path.length).toBeGreaterThan(0)
      }
    })
  }

  it('a violation on an optional field never mentions repo', () => {
    const { violations } = validateConfig(invalidCheckMissingRun)
    expect(violations.length).toBeGreaterThan(0)
    for (const violation of violations) {
      expect(violation.path).not.toContain('repo')
      expect(violation.message).not.toContain('repo')
    }
  })
})

describe('CONFIG_DEFAULTS', () => {
  it('equals the documented schema defaults', () => {
    expect(CONFIG_DEFAULTS).toEqual({
      branches: { integration: 'dev', production: 'main' },
      models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
      modules: { approvalGate: true, previewDatabase: false, release: true, scope: true },
      reviewCycleCap: 5,
    })
  })
})
