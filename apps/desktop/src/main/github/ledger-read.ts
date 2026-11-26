// The ticket a pull request closes, for the budget gate. Stays in main/github/, the app's only GitHub reader.
import { describeHttp } from '@/main/github/envelope'
import { restRequest } from '@/main/github/request'
import { issueFromPrBody } from '@/main/github/budget-ledger'
import type { GitHubReadContext } from '@/main/github/context'
import type { IssueForPr } from '@/main/github/budget-ledger'

export async function issueForPr(ctx: GitHubReadContext, params: { readonly repo: string; readonly pr: number }): Promise<IssueForPr> {
  const pr = String(params.pr)
  const result = await ctx.githubHttp(restRequest(`repos/${params.repo}/pulls/${pr}`))
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
