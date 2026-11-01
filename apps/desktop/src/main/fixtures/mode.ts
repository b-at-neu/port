import { FIXTURE_ENV, FIXTURE_SCENARIOS } from '@/types/fixtures'
import type { FixtureScenario } from '@/types/fixtures'

type FixtureModeResult =
  | { readonly kind: 'off' }
  | { readonly kind: 'ignored' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'on'; readonly userData: string; readonly scenario: FixtureScenario }

// Absent → `populated`; any `FIXTURE_SCENARIOS` member → itself; anything else fails closed, the
// same way an unknown `userData` does.
function parseScenario(raw: string | undefined): FixtureScenario | 'invalid' {
  if (raw === undefined) return 'populated'
  return FIXTURE_SCENARIOS.find((scenario) => scenario === raw) ?? 'invalid'
}

interface FixtureBuild {
  /** The build bundles fixture data. */
  readonly compiled: boolean
  /** A packaged app of this build still honours the flag (the `--mode smoke` copy). */
  readonly packaged: boolean
}

/** Pure — `env`, `isPackaged`, and `isAbsolute` are injected, so `mode.test.ts` needs no Electron or filesystem. `off` unless the flag is exactly `'1'`. `ignored` in a packaged build unless `build.packaged`. `invalid` fails closed — on a build with no fixtures, or rather than guessing a directory or scenario. */
export function fixtureMode(env: Readonly<Record<string, string | undefined>>, isPackaged: boolean, build: FixtureBuild, isAbsolute: (path: string) => boolean): FixtureModeResult {
  if (env[FIXTURE_ENV.flag] !== '1') return { kind: 'off' }
  if (isPackaged && !build.packaged) return { kind: 'ignored' }
  if (!build.compiled) {
    return { kind: 'invalid', reason: `${FIXTURE_ENV.flag} is set but this build carries no fixtures — use \`pnpm dev\`, or build with \`--mode fixtures\`` }
  }

  const userData = env[FIXTURE_ENV.userData]
  if (userData === undefined || userData === '' || !isAbsolute(userData)) {
    return { kind: 'invalid', reason: `${FIXTURE_ENV.userData} must be set to an absolute path` }
  }

  const scenario = parseScenario(env[FIXTURE_ENV.scenario])
  if (scenario === 'invalid') {
    return { kind: 'invalid', reason: `${FIXTURE_ENV.scenario} must be one of: ${FIXTURE_SCENARIOS.join(', ')}` }
  }
  return { kind: 'on', userData, scenario }
}
