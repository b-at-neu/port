import { describe, expect, it } from 'vitest'
import { CLI_OUTDATED_COPY, RUNTIME_COPY } from './copy'
import type { RuntimeDiagnosis } from './types'

// `RUNTIME_COPY`'s type (`Readonly<Record<RuntimeDiagnosis, RuntimeCopy>>`)
// already fails to compile if a diagnosis is missing or an extra key is
// added, so this list exists only to drive the runtime assertions below —
// `scripts/checks/desktop-runtime.ts` cross-checks it against the real
// union so the two can never silently drift apart.
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

describe('RUNTIME_COPY', () => {
  it('every diagnosis has a non-empty title and body', () => {
    for (const diagnosis of ALL_DIAGNOSES) {
      const entry = RUNTIME_COPY[diagnosis]
      expect(entry.title.length).toBeGreaterThan(0)
      expect(entry.body.length).toBeGreaterThan(0)
    }
  })

  it('no entry anywhere mentions an API key', () => {
    for (const diagnosis of ALL_DIAGNOSES) {
      const entry = RUNTIME_COPY[diagnosis]
      expect(entry.title.toLowerCase()).not.toContain('api key')
      expect(entry.body.toLowerCase()).not.toContain('api key')
    }
    expect(CLI_OUTDATED_COPY.title.toLowerCase()).not.toContain('api key')
    expect(CLI_OUTDATED_COPY.body.toLowerCase()).not.toContain('api key')
  })

  it('#145: unauthenticated and token-stale both route to login, never account-owner', () => {
    expect(RUNTIME_COPY.unauthenticated.action).toBe('login')
    expect(RUNTIME_COPY['token-stale'].action).toBe('login')
  })

  it('policy-refused is the only diagnosis routed to the account owner', () => {
    for (const diagnosis of ALL_DIAGNOSES) {
      if (diagnosis === 'policy-refused') continue
      expect(RUNTIME_COPY[diagnosis].action).not.toBe('account-owner')
    }
    expect(RUNTIME_COPY['policy-refused'].action).toBe('account-owner')
  })

  it('verified and unverified need no action', () => {
    expect(RUNTIME_COPY.verified.action).toBeNull()
    expect(RUNTIME_COPY.unverified.action).toBeNull()
  })

  it('the outdated advisory routes to update', () => {
    expect(CLI_OUTDATED_COPY.action).toBe('update')
  })
})
