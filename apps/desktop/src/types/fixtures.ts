export const FIXTURE_SCENARIOS = ['populated', 'empty', 'unregistered', 'failing', 'registry-error'] as const

export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number]
