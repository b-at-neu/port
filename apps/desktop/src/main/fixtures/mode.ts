// Fixture mode's own switch (#317) — pure, so `mode.test.ts` covers every
// branch with no Electron and no filesystem. `main/index.ts` calls
// `fixtureMode` with the real `process.env`, `app.isPackaged`, and
// `node:path`'s `isAbsolute`, injected rather than imported here.
export const FIXTURE_ENV = { flag: 'PORT_FIXTURES', userData: 'PORT_FIXTURES_USER_DATA', scenario: 'PORT_FIXTURES_SCENARIO' } as const

export type FixtureScenario = 'populated' | 'empty'

export type FixtureModeResult =
  | { readonly kind: 'off' }
  | { readonly kind: 'ignored' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'on'; readonly userData: string; readonly scenario: FixtureScenario }

// Absent → `populated`; `empty` → `empty`; anything else fails closed, the
// same way an unknown `userData` does.
function parseScenario(raw: string | undefined): FixtureScenario | 'invalid' {
  if (raw === undefined) return 'populated'
  if (raw === 'empty') return 'empty'
  if (raw === 'populated') return 'populated'
  return 'invalid'
}

/**
 * `off` unless the flag is exactly `'1'` (so `'true'`/`'0'`/anything else
 * never turns fixture mode on). `ignored` in a packaged build, regardless of
 * the flag — a packaged app must never silently serve canned data. `invalid`
 * fails closed: a fixture run against the operator's real profile would take
 * their single-instance lock and write their theme preference, so an absent
 * or relative `userData` refuses rather than guessing a directory. An
 * unrecognised `PORT_FIXTURES_SCENARIO` is equally `invalid`.
 */
export function fixtureMode(env: Readonly<Record<string, string | undefined>>, isPackaged: boolean, isAbsolute: (path: string) => boolean): FixtureModeResult {
  if (env[FIXTURE_ENV.flag] !== '1') return { kind: 'off' }
  if (isPackaged) return { kind: 'ignored' }

  const userData = env[FIXTURE_ENV.userData]
  if (userData === undefined || userData === '' || !isAbsolute(userData)) {
    return { kind: 'invalid', reason: `${FIXTURE_ENV.userData} must be set to an absolute path` }
  }

  const scenario = parseScenario(env[FIXTURE_ENV.scenario])
  if (scenario === 'invalid') {
    return { kind: 'invalid', reason: `${FIXTURE_ENV.scenario} must be 'populated' or 'empty'` }
  }
  return { kind: 'on', userData, scenario }
}
