// Fixture mode's own canned release status: `acme/widgets` has an upcoming release and three published ones; the `empty` scenario and every other repository has neither.
import type { FixtureScenario } from '@/types/fixtures'
import type { ReleaseEntry, ReleaseInfo, ReleaseStatus, ReleaseStatusResponse } from '@/types/release'
import type { RepoId } from '@/utils/repos'
import { buildCandidates } from '@/utils/release/version'
import { WIDGETS_ID } from '@/main/fixtures/repos'

const ENTRIES: readonly ReleaseEntry[] = [
  { number: 169, title: 'Add dark mode to the email templates', labels: ['enhancement', 'design'], dependency: false },
  { number: 164, title: 'Retry failed webhook deliveries', labels: ['enhancement'], dependency: false },
  { number: 161, title: 'Fix the stale cache after a settings change', labels: ['bug'], dependency: false },
  { number: 158, title: 'Document the webhook retry policy', labels: ['documentation'], dependency: false },
  { number: 153, title: 'Bump vite to 7.1', labels: ['dependencies'], dependency: true },
]

function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60_000).toISOString()
}

function releasesOf(now: Date): readonly ReleaseInfo[] {
  const release = (tag: string, name: string, days: number, latest: boolean, notes: string): ReleaseInfo => ({
    tagName: tag,
    name,
    url: `https://github.com/acme/widgets/releases/tag/${tag}`,
    publishedAt: daysAgo(now, days),
    isPrerelease: false,
    isLatest: latest,
    description: notes,
  })
  return [
    release('v0.2.0', 'v0.2.0', 9, true, '- Faster search results\n- Saved filters on the board\n- Minor enhancements and bug fixes\n'),
    release('v0.1.1', 'v0.1.1', 31, false, '- Fixed a crash when a repository has no tags\n- Minor enhancements and bug fixes\n'),
    release('v0.1.0', 'v0.1.0', 58, false, '- The first release\n- Minor enhancements and bug fixes\n'),
  ]
}

export function fixtureReleaseStatus(now: Date, scenario: FixtureScenario, repoId: RepoId): ReleaseStatusResponse {
  const populated = scenario === 'populated' && repoId === WIDGETS_ID
  const base = { versionSource: 'package' as const, production: 'main', integration: 'dev', postPublishHook: 'node scripts/dev-window.ts', readAt: now.toISOString(), productionHead: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0' }
  const status: ReleaseStatus = populated
    ? { ...base, phase: { kind: 'idle' }, currentVersion: '0.2.0', candidates: buildCandidates('0.2.0', ENTRIES), entries: ENTRIES, truncatedNote: null, releases: releasesOf(now) }
    : { ...base, phase: { kind: 'nothing-to-release' }, currentVersion: null, candidates: [], entries: [], truncatedNote: null, releases: [] }
  return { ok: true, status }
}
