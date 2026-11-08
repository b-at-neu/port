// fetchReleaseIssues: the tickets a published release's merged pull requests closed. Fails toward showing less with a note; a transport or whole-query failure is `ok: false`.
import { githubHttp } from '@/main/platform/github-http'
import type { GitHubTransport } from '@/types/platform'
import type { GitHubRepoRef } from '@/types/github'
import type { ReleaseIssue, ReleaseIssuesResponse } from '@/types/release'
import { labelsOf } from '@/main/github/backlog'
import { bodyOf, classifyFailure, describeHttp, parseEnvelope } from '@/main/github/envelope'
import { buildIncludedIssuesQuery } from '@/main/github/release-query'
import { nodesOf, obj, parseBody, str } from '@/main/github/release'
import { repoGraphqlRequest, restRequest } from '@/main/github/request'

const COMMIT_PAGE = 100
const SHA = /^[0-9a-f]{40}$/

export interface FetchReleaseIssuesParams {
  readonly repo: GitHubRepoRef
  readonly tag: string
  readonly previousTag: string | null
  readonly github?: GitHubTransport
}

type CommitRead = { readonly ok: true; readonly shas: readonly string[]; readonly note: string | null } | { readonly ok: false; readonly message: string }

// Merge commits are skipped, matching the changelog gather: their pull request's own commits are already in the list.
function shasOf(list: unknown): readonly string[] | null {
  if (!Array.isArray(list)) return null
  return list.flatMap((item) => {
    const commit = obj(item)
    const sha = str(commit?.sha)
    const parents = Array.isArray(commit?.parents) ? commit.parents.length : 1
    return sha !== null && SHA.test(sha) && parents <= 1 ? [sha] : []
  })
}

async function readShas(github: GitHubTransport, repo: GitHubRepoRef, tag: string, previousTag: string | null): Promise<CommitRead> {
  const base = `repos/${repo.owner}/${repo.name}`
  if (previousTag === null) {
    const result = await github(restRequest(`${base}/commits?sha=${encodeURIComponent(tag)}&per_page=${String(COMMIT_PAGE)}`))
    if (!result.ok) return { ok: false, message: describeHttp(result) }
    const list = parseBody(result.body)
    const shas = shasOf(list)
    if (shas === null || !Array.isArray(list)) return { ok: false, message: "GitHub's commit list wasn't JSON" }
    return { ok: true, shas, note: list.length >= COMMIT_PAGE ? `This is the first release, so only its newest ${String(COMMIT_PAGE)} commits were read.` : null }
  }
  const result = await github(restRequest(`${base}/compare/${encodeURIComponent(previousTag)}...${encodeURIComponent(tag)}?per_page=${String(COMMIT_PAGE)}`))
  if (!result.ok) return { ok: false, message: describeHttp(result) }
  const body = obj(parseBody(result.body))
  const shas = shasOf(body?.commits)
  if (body === null || shas === null || !Array.isArray(body.commits)) return { ok: false, message: "GitHub's comparison wasn't JSON" }
  const total = typeof body.total_commits === 'number' ? body.total_commits : body.commits.length
  return { ok: true, shas, note: total > body.commits.length ? `Read the first ${String(body.commits.length)} of ${String(total)} commits, so some tickets may be missing.` : null }
}

function issueOf(node: Readonly<Record<string, unknown>>, repo: GitHubRepoRef): ReleaseIssue | null {
  const number = node.number
  const title = str(node.title)
  const url = str(node.url)
  if (typeof number !== 'number' || title === null || url === null) return null
  const owner = str(obj(node.repository)?.nameWithOwner)
  if (owner === null || owner.toLowerCase() !== `${repo.owner}/${repo.name}`.toLowerCase()) return null
  return { number, title, url, labels: labelsOf(node.labels) }
}

export async function fetchReleaseIssues(params: FetchReleaseIssuesParams): Promise<ReleaseIssuesResponse> {
  const github = params.github ?? githubHttp
  const { repo } = params
  const read = await readShas(github, repo, params.tag, params.previousTag)
  if (!read.ok) return { ok: false, message: read.message }
  if (read.shas.length === 0) return { ok: true, issues: [], note: read.note }

  const variables = Object.fromEntries(read.shas.map((sha, index) => [`c${String(index)}`, sha]))
  const result = await github(repoGraphqlRequest(buildIncludedIssuesQuery(read.shas.length), repo, variables))
  const text = bodyOf(result)
  const parsed = text === undefined ? undefined : parseEnvelope(text)
  const verdict = classifyFailure(result, parsed)
  const repository = parsed?.ok === true ? obj(parsed.value.data?.repository) : null
  if (verdict.kind !== 'ok' || repository === null) return { ok: false, message: verdict.kind === 'ok' ? 'GitHub returned no repository data.' : verdict.message }

  const issues = new Map<number, ReleaseIssue>()
  read.shas.forEach((_sha, index) => {
    const commit = obj(repository[`c${String(index)}`])
    for (const pull of nodesOf(commit?.associatedPullRequests)) {
      if (pull.merged !== true) continue
      for (const node of nodesOf(pull.closingIssuesReferences)) {
        const issue = issueOf(node, repo)
        if (issue !== null) issues.set(issue.number, issue)
      }
    }
  })
  const partial = (parsed?.ok === true ? (parsed.value.errors ?? []) : []).length > 0 ? "Some PRs couldn't be read, so this list may be incomplete." : null
  const note = [read.note, partial].filter((part): part is string => part !== null).join(' ')
  return { ok: true, issues: [...issues.values()].sort((a, b) => b.number - a.number), note: note === '' ? null : note }
}
