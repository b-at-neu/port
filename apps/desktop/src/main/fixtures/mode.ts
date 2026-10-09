// Pure, so `mode.test.ts` covers every branch with no Electron and no filesystem — `process.env`, `isPackaged`, and `isAbsolute` are injected, not imported.
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

/** `off` unless the flag is exactly `'1'`. `ignored` in a packaged build regardless of the flag. `invalid` fails closed rather than guessing a directory or scenario. */
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
