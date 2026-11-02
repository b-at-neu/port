import type { FixtureScenario } from '@/types/fixtures'

// The `#app-fixtures` target in builds that carry no fixture data; `fixtureMode` never lets a run reach it.
export function registerFixtureIpc(scenario: FixtureScenario): never {
  throw new Error(`fixture mode is not compiled into this build (scenario '${scenario}')`)
}
