import { describe, expect, it } from 'vitest'
import { runtimeDiagnosisModel } from './runtime-model'
import type { RuntimeDiagnosis, RuntimePreflight, RuntimeProbe } from '../../../shared/runtime/types'

const ALL_DIAGNOSES: readonly RuntimeDiagnosis[] = [
  'unverified',
  'verified',
  'cli-missing',
  'bundled-fallback',
  'cli-unusable',
  'unauthenticated',
  'token-stale',
  'policy-refused',
  'probe-failed',
]

function preflight(overrides: Partial<RuntimePreflight> = {}): RuntimePreflight {
  return {
    checkedAt: '2026-01-01T00:00:00.000Z',
    executable: null,
    version: null,
    credentials: null,
    apiKeyInEnvironment: false,
    diagnosis: 'unverified',
    detail: null,
    ...overrides,
  }
}

function probe(overrides: Partial<RuntimeProbe> = {}): RuntimeProbe {
  return {
    checkedAt: '2026-01-01T00:00:00.000Z',
    repo: 'o/n',
    elapsedMs: 1200,
    apiKeyInEnvironment: false,
    diagnosis: 'verified',
    detail: null,
    ...overrides,
  }
}

const READY_REPO = { id: 'repo-1', repo: 'o/n' }

describe('runtimeDiagnosisModel', () => {
  for (const diagnosis of ALL_DIAGNOSES) {
    it(`renders a title and pill for '${diagnosis}'`, () => {
      const model = runtimeDiagnosisModel(preflight({ diagnosis }), null, READY_REPO, false)
      expect(model.title.length).toBeGreaterThan(0)
      expect(model.pillLabel.length).toBeGreaterThan(0)
    })
  }

  it('unverified is idle with no action disabled when a repo is ready', () => {
    const model = runtimeDiagnosisModel(preflight({ diagnosis: 'unverified' }), null, READY_REPO, false)
    expect(model.pillStatus).toBe('idle')
    expect(model.action).toEqual({ label: 'Test connection', kind: 'test', disabledReason: null })
  })

  it('unverified disables Test connection with a reason when no repo is ready', () => {
    const model = runtimeDiagnosisModel(preflight({ diagnosis: 'unverified' }), null, null, false)
    expect(model.action?.disabledReason).toBe('Register a repository to test the connection.')
  })

  it('withholds the action entirely while repos:list is still pending, rather than reading it as no ready repo', () => {
    const model = runtimeDiagnosisModel(preflight({ diagnosis: 'unverified' }), null, null, false, true)
    expect(model.action).toBeNull()
  })

  it('a pending repos query never withholds Retry for diagnoses that do not need a repo', () => {
    const model = runtimeDiagnosisModel(preflight({ diagnosis: 'cli-missing' }), null, null, false, true)
    expect(model.action).toEqual({ label: 'Retry', kind: 'retry', disabledReason: null })
  })

  it('every other actionable diagnosis never disables Retry for a missing repo', () => {
    const model = runtimeDiagnosisModel(preflight({ diagnosis: 'cli-missing' }), null, null, false)
    expect(model.action).toEqual({ label: 'Retry', kind: 'retry', disabledReason: null })
  })

  it('verified and policy-refused offer no action', () => {
    expect(runtimeDiagnosisModel(preflight({ diagnosis: 'verified' }), probe(), READY_REPO, false).action).toBeNull()
    expect(runtimeDiagnosisModel(preflight({ diagnosis: 'policy-refused' }), null, READY_REPO, false).action).toBeNull()
  })

  it('a probe overrides the preflight diagnosis once one has run', () => {
    const model = runtimeDiagnosisModel(preflight({ diagnosis: 'unverified' }), probe({ diagnosis: 'probe-failed', detail: 'boom' }), READY_REPO, false)
    expect(model.pillLabel).toBe('Test failed')
    expect(model.detail).toBe('boom')
  })

  it('a successful probe names the repo and elapsed time', () => {
    const model = runtimeDiagnosisModel(preflight(), probe({ repo: 'acme/widgets', elapsedMs: 1500 }), READY_REPO, false)
    expect(model.body).toBe('Verified against acme/widgets in 1.5s')
  })

  it('surfaces the API key note only when the probe reports one', () => {
    expect(runtimeDiagnosisModel(preflight(), probe({ apiKeyInEnvironment: true }), READY_REPO, false).notes).toContain(
      'An ANTHROPIC_API_KEY is set in this environment — this turn may not have used your subscription.',
    )
    expect(runtimeDiagnosisModel(preflight(), probe({ apiKeyInEnvironment: false }), READY_REPO, false).notes).toHaveLength(0)
  })

  it('surfaces the outdated-CLI note when belowMinimum, advisory only', () => {
    const model = runtimeDiagnosisModel(preflight({ version: { raw: '1.0.0', belowMinimum: true } }), null, READY_REPO, false)
    expect(model.notes).toContain('Claude Code is older than the version this app expects.')
  })

  it('surfaces the probe-unreachable error as its own field, never folded into notes', () => {
    const model = runtimeDiagnosisModel(preflight(), null, READY_REPO, true)
    expect(model.probeErrorMessage).toBe("Couldn't reach the main process to test the connection.")
    expect(model.notes).not.toContain(model.probeErrorMessage)
  })

  it('omits the version line when nothing resolved, includes path when it has', () => {
    expect(runtimeDiagnosisModel(preflight(), null, READY_REPO, false).versionLine).toBeNull()
    const model = runtimeDiagnosisModel(preflight({ version: { raw: '2.1.3', belowMinimum: false }, executable: { path: '/usr/local/bin/claude' } }), null, READY_REPO, false)
    expect(model.versionLine).toBe('Claude Code 2.1.3 · /usr/local/bin/claude')
  })
})
