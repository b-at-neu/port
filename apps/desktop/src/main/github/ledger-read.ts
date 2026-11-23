// The ticket a pull request closes, read from the pull request's own body for the budget gate. A pull request read, so it stays in main/github/.
import { githubHttp } from '@/main/platform/github-http'
import { describeHttp } from '@/main/github/envelope'
import { restRequest } from '@/main/github/request'
import { issueFromPrBody } from '@/main/dispatch/budget-ledger'
import type { IssueForPr } from '@/types/budget'
import type { GitHubTransport } from '@/types/platform'

export function createPullRequestBodyReader(deps: { readonly github?: GitHubTransport } = {}): { readonly issueForPr: (params: { readonly repo: string; readonly pr: number }) => Promise<IssueForPr> } {
  const github = deps.github ?? githubHttp

  async function issueForPr(params: { readonly repo: string; readonly pr: number }): Promise<IssueForPr> {
    const pr = String(params.pr)
    const result = await github(restRequest(`repos/${params.repo}/pulls/${pr}`))
    if (!result.ok) return { ok: false, why: `could not read PR #${pr}'s body: ${describeHttp(result)}` }
    let body: unknown
    try {
      body = (JSON.parse(result.body) as { readonly body?: unknown }).body
    } catch {
      return { ok: false, why: `could not read PR #${pr}'s body: GitHub's reply wasn't JSON` }
    }
    const issue = issueFromPrBody(typeof body === 'string' ? body : '')
    if (issue === null) return { ok: false, why: `PR #${pr}'s body has no 'Closes #N' on its first line — cannot resolve its ticket.` }
    return { ok: true, issue }
  }

  return { issueForPr }
}
