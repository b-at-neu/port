// Fixture mode's own canned release status: `acme/widgets` has an upcoming release and three published ones; the `empty` scenario and every other repository has neither.
import type { FixtureScenario } from '@/types/fixtures'
import type { BacklogLabel } from '@/types/backlog'
import type { ReleaseEntry, ReleaseInfo, ReleaseIssue, ReleaseIssuesRequest, ReleaseIssuesResponse, ReleaseStatus, ReleaseStatusResponse } from '@/types/release'
import type { RepoId } from '@/utils/repos'
import { WIDGETS_ID } from './repos'

const BUG: BacklogLabel = { name: 'bug', color: 'd73a4a' }
const ENHANCEMENT: BacklogLabel = { name: 'enhancement', color: 'a2eeef' }
const DESIGN: BacklogLabel = { name: 'design', color: 'd4c5f9' }
const DOCUMENTATION: BacklogLabel = { name: 'documentation', color: '0075ca' }
const DEPENDENCIES: BacklogLabel = { name: 'dependencies', color: '0366d6' }

function entry(now: Date, number: number, title: string, labels: readonly BacklogLabel[], days: number, dependency = false): ReleaseEntry {
  return { number, title, url: `https://github.com/acme/widgets/pull/${String(number)}`, labels, mergedAt: daysAgo(now, days), dependency }
}

function entriesOf(now: Date): readonly ReleaseEntry[] {
  return [
    entry(now, 169, 'Add dark mode to the email templates', [ENHANCEMENT, DESIGN], 2),
    entry(now, 164, 'Retry failed webhook deliveries', [ENHANCEMENT], 3),
    entry(now, 161, 'Fix the stale cache after a settings change', [BUG], 4),
    entry(now, 158, 'Document the webhook retry policy', [DOCUMENTATION], 6),
    entry(now, 153, 'Bump vite to 7.1', [DEPENDENCIES], 7, true),
  ]
}

function issue(number: number, title: string, labels: readonly BacklogLabel[] = []): ReleaseIssue {
  return { number, title, url: `https://github.com/acme/widgets/issues/${String(number)}`, labels }
}

const ISSUES_BY_TAG: Readonly<Record<string, readonly ReleaseIssue[]>> = {
  'v0.2.0': [
    issue(169, 'Add dark mode to the email templates', [ENHANCEMENT]),
    issue(164, 'Retry failed webhook deliveries', [ENHANCEMENT]),
    issue(161, 'Fix the stale cache after a settings change', [BUG]),
    issue(158, 'Document the webhook retry policy'),
    issue(152, 'Saved filters reset when the board reloads', [BUG]),
    issue(149, 'Search results ignore the repository filter', [BUG]),
    issue(147, 'Show the last sync time in the footer', [ENHANCEMENT]),
    issue(143, 'Keyboard shortcut to jump to the next ticket'),
    issue(140, 'Faster search over large boards', [ENHANCEMENT]),
    issue(138, 'Sort order lost after switching tabs', [BUG]),
    issue(135, 'Export the board as CSV'),
    issue(131, 'Tooltip covers the filter menu on small windows', [BUG]),
  ],
  'v0.1.0': [issue(24, 'Set up the board layout', [ENHANCEMENT]), issue(19, 'Crash on an empty repository', [BUG]), issue(12, 'Add a README')],
}

export function fixtureReleaseIssues(scenario: FixtureScenario, request: ReleaseIssuesRequest): ReleaseIssuesResponse {
  const populated = scenario === 'populated' && request.repoId === WIDGETS_ID
  return { ok: true, issues: populated ? (ISSUES_BY_TAG[request.tag] ?? []) : [], note: null }
}

function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60_000).toISOString()
}

function releasesOf(now: Date): readonly ReleaseInfo[] {
  const release = (tag: string, name: string, days: number, latest: boolean, notes: string, previousTag: string | null): ReleaseInfo => ({
    tagName: tag,
    previousTag,
    name,
    url: `https://github.com/acme/widgets/releases/tag/${tag}`,
    publishedAt: daysAgo(now, days),
    isPrerelease: false,
    isLatest: latest,
    description: notes,
  })
  return [
    release('v0.2.0', 'v0.2.0', 9, true, '- Faster search results\n- Saved filters on the board\n- Minor enhancements and bug fixes\n', 'v0.1.1'),
    release('v0.1.1', 'v0.1.1', 31, false, '- Fixed a crash when a repository has no tags\n- Minor enhancements and bug fixes\n', 'v0.1.0'),
    release('v0.1.0', 'v0.1.0', 58, false, '- The first release\n- Minor enhancements and bug fixes\n', null),
  ]
}

export function fixtureReleaseStatus(now: Date, scenario: FixtureScenario, repoId: RepoId): ReleaseStatusResponse {
  const populated = scenario === 'populated' && repoId === WIDGETS_ID
  const base = { versionSource: 'package' as const, production: 'main', integration: 'dev', postPublishHook: 'node scripts/dev-window.ts', readAt: now.toISOString(), productionHead: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0' }
  const status: ReleaseStatus = populated
    ? { ...base, phase: { kind: 'idle' }, currentVersion: '0.2.0', sinceTag: 'v0.2.0', entries: entriesOf(now), truncatedNote: null, releases: releasesOf(now) }
    : { ...base, phase: { kind: 'nothing-to-release' }, currentVersion: null, sinceTag: null, entries: [], truncatedNote: null, releases: [] }
  return { ok: true, status }
}
