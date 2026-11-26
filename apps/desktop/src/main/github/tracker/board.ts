// The issue half of the board read: a paged issue sweep with the repository's label list and the
// signed-in login, tracked issues by number, then the heavy per-issue details.
import type { GitHubReadContext } from '@/main/github/context'
import { applyItemDetails, mapPipelineItems } from '@/main/github/map'
import { asRecord, readDetailChunks, readTrackedChunks, selectTracked, sweepSurface } from '@/main/github/sweep'
import { buildIssueDetailsQuery, buildIssueSweepQuery, buildTrackedIssuesQuery } from '@/main/github/tracker/query'
import type { GraphQLErrorEntry, PipelineItem } from '@/types/github'
import type { BoardIssuesFetch, BoardIssuesParams } from '@/main/github/tracker/types'
import type { LabelKey, RepoLabels } from '@/utils/labels/vocabulary'

// Only an issue alias's own blockedBy/comments/closedByPullRequestsReferences error is per-field: it costs a tag, never the board.
const PER_FIELD_ERRORS: ReadonlySet<unknown> = new Set(['blockedBy', 'comments', 'closedByPullRequestsReferences'])

/** The issue stages whose closing pull requests are read: one that already opened its pull request can be adopted instead of re-dispatched. */
const CLOSING_READ_KEYS: readonly LabelKey[] = ['planApproved', 'inProgress', 'blocked', 'prOpened']

/** `null`, never a guess, when the alias is absent, malformed, or named in `errors[].path`.
 *  Unlike `fetchClaimPreflight`'s `viewerLogin`, this never fails the whole fetch. */
function toViewer(value: unknown, errors: readonly GraphQLErrorEntry[] | undefined): string | null {
  if ((errors ?? []).some((error) => error.path?.[0] === 'viewer')) return null
  const login = asRecord(value)?.login
  return typeof login === 'string' && login !== '' ? login : null
}

/** `repoLabels` truncation is reported as `unverified`, never as a confidently-short list. */
function toRepoLabels(value: unknown): RepoLabels {
  const connection = asRecord(value)
  if (connection === undefined) return { ok: false, reason: 'repoLabels alias missing from the response' }
  const totalCount = connection.totalCount
  const nodes = connection.nodes
  if (typeof totalCount !== 'number' || !Array.isArray(nodes)) {
    return { ok: false, reason: 'repoLabels alias malformed' }
  }
  if (totalCount > nodes.length) {
    return { ok: false, reason: `label list truncated at ${nodes.length} of ${totalCount}` }
  }
  const names: string[] = []
  for (const node of nodes) {
    const name = asRecord(node)?.name
    if (typeof name === 'string') names.push(name)
  }
  return { ok: true, names }
}

/** Every issue the board shows, the repository's real label list, and the signed-in login. Never filters the reply server-side, and no path returns an empty list for a read that did not succeed. */
export async function readBoardIssues(ctx: GitHubReadContext, params: BoardIssuesParams): Promise<BoardIssuesFetch> {
  const github = ctx.githubHttp
  const { repo, vocabulary, tracked } = params

  // With no enabled label one page still runs, for `repoLabels` and `viewer`.
  const sweep = await sweepSurface(github, repo, { alias: 'issues', connection: vocabulary.labels.length > 0, build: (page) => buildIssueSweepQuery(vocabulary, page) })
  if (!sweep.ok) return sweep

  const viewer = toViewer(sweep.first.data.viewer, sweep.first.errors)
  const repoLabels = toRepoLabels(sweep.first.repository.repoLabels)

  let swept: readonly PipelineItem[] = mapPipelineItems(sweep.nodes, 'issue', vocabulary, `${repo.owner}/${repo.name}`)
  let read: readonly PipelineItem[] = []
  let closed: readonly number[] = []
  let rateLimit = sweep.rateLimit
  if (tracked !== null) {
    const selected = selectTracked(swept, tracked)
    const byNumber = await readTrackedChunks(github, repo, vocabulary, 'issue', selected.missing, rateLimit, buildTrackedIssuesQuery)
    if (!byNumber.ok) return byNumber
    swept = selected.kept
    read = byNumber.items
    closed = byNumber.closed
    rateLimit = byNumber.rateLimit
  }

  const detailed = await readDetailChunks(github, repo, rateLimit, {
    kind: 'issue',
    items: [...swept, ...read],
    perField: PER_FIELD_ERRORS,
    build: (chunk) => buildIssueDetailsQuery(chunk.map((item) => ({ number: item.number, blockerComments: item.matchedKeys.includes('blocked'), closingPullRequests: CLOSING_READ_KEYS.some((key) => item.matchedKeys.includes(key)) }))),
  })
  if (!detailed.ok) return detailed

  const applied = applyItemDetails([...swept, ...read], detailed.details)
  return {
    ok: true,
    swept: applied.slice(0, swept.length),
    read: applied.slice(swept.length),
    closed,
    unavailable: sweep.unavailable,
    truncated: sweep.truncated,
    rateLimit: detailed.rateLimit,
    repoLabels,
    viewer,
  }
}
