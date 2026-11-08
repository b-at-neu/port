// readMergedPrs: the pull requests merged into the integration branch inside a release window, newest merge first.
import type { GitHubTransport } from '@/types/platform'
import type { GitHubRepoRef } from '@/types/github'
import type { ReleaseEntry } from '@/types/release'
import { labelsOf } from '@/main/github/backlog'
import { bodyOf, classifyFailure, parseEnvelope } from '@/main/github/envelope'
import { MERGED_PRS_PAGE, buildMergedPrsQuery } from '@/main/github/release-query'
import { nodesOf, obj, str } from '@/main/github/release'
import { repoGraphqlRequest } from '@/main/github/request'
import { cleanTitle } from '@/utils/release/changelog'

export const MAX_PAGES = 10
export const CAPPED_NOTE = `Showing the newest ${String(MAX_PAGES * MERGED_PRS_PAGE)} merged PRs. Older ones aren't listed.`
export const PARTIAL_NOTE = "Couldn't read older PRs, so this list may be incomplete."
const DEPENDENCY_LABEL = /dependenc/i

export interface ReadMergedPrsParams {
  readonly github: GitHubTransport
  readonly repo: GitHubRepoRef
  readonly base: string
  readonly since: string | null
  readonly until: string | null
}

export type MergedPrsRead = { readonly ok: true; readonly entries: readonly ReleaseEntry[]; readonly note: string | null } | { readonly ok: false; readonly message: string }

type Page = { readonly ok: true; readonly nodes: readonly Readonly<Record<string, unknown>>[]; readonly next: string | null } | { readonly ok: false; readonly message: string }

async function readPage(params: ReadMergedPrsParams, after: string | null): Promise<Page> {
  const variables = { base: params.base, ...(after === null ? {} : { after }) }
  const result = await params.github(repoGraphqlRequest(buildMergedPrsQuery(), params.repo, variables))
  const text = bodyOf(result)
  const parsed = text === undefined ? undefined : parseEnvelope(text)
  const verdict = classifyFailure(result, parsed)
  if (verdict.kind !== 'ok') return { ok: false, message: verdict.message }
  const body = parsed?.ok === true ? parsed.value : null
  if ((body?.errors ?? []).length > 0) return { ok: false, message: 'GitHub reported an error reading the page' }
  const connection = obj(obj(body?.data?.repository)?.pullRequests)
  if (connection === null || !Array.isArray(connection.nodes)) return { ok: false, message: 'GitHub returned no pull requests' }
  const pageInfo = obj(connection.pageInfo)
  const cursor = str(pageInfo?.endCursor)
  return { ok: true, nodes: nodesOf(connection), next: pageInfo?.hasNextPage === true && cursor !== null ? cursor : null }
}

function entryOf(node: Readonly<Record<string, unknown>>): ReleaseEntry | null {
  const { number } = node
  const title = str(node.title)
  const url = str(node.url)
  const mergedAt = str(node.mergedAt)
  if (typeof number !== 'number' || title === null || url === null || mergedAt === null || Number.isNaN(Date.parse(mergedAt))) return null
  const labels = labelsOf(node.labels)
  const bot = str(obj(node.author)?.__typename) === 'Bot'
  return { number, title: cleanTitle(title), url, labels, mergedAt, dependency: bot || labels.some((label) => DEPENDENCY_LABEL.test(label.name)) }
}

// `mergedAt <= updatedAt` always holds, so a page whose last node was updated before `since` cannot hold a later merge.
function pastWindow(nodes: readonly Readonly<Record<string, unknown>>[], since: number | null): boolean {
  if (since === null) return false
  const updated = str(nodes[nodes.length - 1]?.updatedAt)
  return updated !== null && Date.parse(updated) < since
}

export async function readMergedPrs(params: ReadMergedPrsParams): Promise<MergedPrsRead> {
  const since = params.since === null ? null : Date.parse(params.since)
  const until = params.until === null ? null : Date.parse(params.until)
  const kept: ReleaseEntry[] = []
  let after: string | null = null
  let note: string | null = null
  for (let page = 1; page <= MAX_PAGES; page++) {
    const read = await readPage(params, after)
    if (!read.ok) {
      if (page === 1) return { ok: false, message: `Couldn't read the merged PRs: ${read.message}` }
      note = PARTIAL_NOTE
      break
    }
    for (const node of read.nodes) {
      const entry = entryOf(node)
      if (entry === null) continue
      const merged = Date.parse(entry.mergedAt)
      if ((since === null || since < merged) && (until === null || merged <= until)) kept.push(entry)
    }
    if (read.next === null || pastWindow(read.nodes, since)) break
    if (page === MAX_PAGES) note = CAPPED_NOTE
    after = read.next
  }
  return { ok: true, entries: kept.sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt)), note }
}
