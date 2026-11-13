// The update channels' canned state, one consistent answer per scenario.
import type { FixtureScenario } from '@/types/fixtures'
import type { UpdateState, UpdateTrigger } from '@/types/update'

const CURRENT = '0.1.0'

export function fixtureUpdateState(now: Date, scenario: FixtureScenario, trigger: UpdateTrigger): UpdateState {
  const checkedAt = new Date(now.getTime() - 2 * 60_000).toISOString()
  if (scenario === 'update-available') {
    return {
      kind: 'available',
      current: CURRENT,
      trigger,
      checkedAt,
      release: {
        version: '0.2.0',
        tag: 'v0.2.0',
        notesUrl: 'https://github.com/acme/port/releases/tag/v0.2.0',
        publishedAt: checkedAt,
        assets: [{ name: 'port-0.2.0.dmg', url: 'https://github.com/acme/port/releases/download/v0.2.0/port-0.2.0.dmg', size: 120_000_000, contentType: 'application/x-apple-diskimage' }],
      },
    }
  }
  if (scenario === 'failing') return { kind: 'error', current: CURRENT, reason: 'offline', detail: 'fetch failed', trigger, checkedAt }
  if (scenario === 'registry-error') return { kind: 'checking', current: CURRENT, trigger, startedAt: checkedAt }
  return { kind: 'up-to-date', current: CURRENT, latest: CURRENT, trigger, checkedAt }
}
