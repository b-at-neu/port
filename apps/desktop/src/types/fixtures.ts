export const FIXTURE_SCENARIOS = ['populated', 'empty', 'unregistered', 'failing', 'registry-error'] as const

export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number]

// Lives here, import-free, because the Playwright harness loads it without the `@/` alias.
export const FIXTURE_ENV = { flag: 'PORT_FIXTURES', userData: 'PORT_FIXTURES_USER_DATA', scenario: 'PORT_FIXTURES_SCENARIO' } as const
