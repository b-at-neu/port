// Reads for the budget gate: a ticket's `## Pipeline Cost` comment, and the ticket a pull request closes. Both stay in main/github/, the app's only GitHub reader.
import { githubHttp } from '@/main/platform/github-http'
import { bodyOf, describeHttp, parseEnvelope } from '@/main/github/envelope'
import { graphqlRequest, restRequest } from '@/main/github/request'
import { issueFromPrBody, parseLedger } from '@/main/dispatch/budget-ledger'
import type { GraphQLErrorEntry } from '@/types/github'
import type { IssueForPr, LedgerRead, LedgerReader } from '@/types/budget'
import type { GitHubTransport } from '@/types/platform'

const LEDGER_HEADING = '## Pipeline Cost'

/** The unavailable parts of a partial GraphQL response: every string segment named in `errors[].path`. */
function unavailableAliases(errors: readonly GraphQLErrorEntry[] | undefined): ReadonlySet<string> {
  const paths = (errors ?? []).flatMap((e) => e.path ?? [])
  return new Set(paths.filter((seg): seg is string => typeof seg === 'string'))
}

interface LedgerNode {
  readonly databaseId?: number
  readonly body?: string
  readonly author?: { readonly login?: string } | null
}

interface LedgerData {
  readonly viewer?: { readonly login?: string } | null
  readonly repository?: { readonly issue?: { readonly comments?: { readonly nodes?: unknown } | null } | null } | null
}

export function createLedgerReader(deps: { readonly github?: GitHubTransport } = {}): LedgerReader {
  const github = deps.github ?? githubHttp

  async function readLedger(params: { readonly owner: string; readonly name: string; readonly issue: number }): Promise<LedgerRead> {
    const { issue } = params
    // One round trip for both facts: the ledger comment is scoped to this account's own author.
    const document = `query($owner: String!, $name: String!) { viewer { login } repository(owner: $owner, name: $name) { issue(number: ${String(issue)}) { comments(first: 100) { nodes { databaseId body author { login } } } } } }`
    const result = await github(graphqlRequest(document, { owner: params.owner, name: params.name }))
    // The envelope is read whatever the status: a response can carry `errors` beside usable data.
    const envelope = parseEnvelope(bodyOf(result) ?? '')
    if (!envelope.ok) return { ok: false, why: result.ok ? 'GitHub returned no parseable envelope' : describeHttp(result) }
    const { data, errors } = envelope.value
    if (data === undefined || data === null) return { ok: false, why: errors?.[0]?.message || 'GitHub returned an envelope carrying no data' }

    const unavailable = unavailableAliases(errors)
    for (const alias of ['viewer', 'repository', 'issue', 'comments']) {
      if (unavailable.has(alias)) return { ok: false, why: `GitHub reported '${alias}' unavailable while reading #${String(issue)}'s ledger` }
    }
    const typed = data as LedgerData
    const login = typed.viewer?.login
    if (!login) return { ok: false, why: "GitHub returned no viewer login — cannot tell this account's own ledger comment from anyone else's" }
    const nodes = typed.repository?.issue?.comments?.nodes
    if (!Array.isArray(nodes)) return { ok: false, why: `GitHub returned no comment list for #${String(issue)} — an absent list is not an empty one` }

    const mine = (nodes as readonly LedgerNode[]).find((n) => n.body?.startsWith(LEDGER_HEADING) === true && n.author?.login === login)
    if (mine === undefined) return { ok: true, rows: [], seconds: 0, ref: null }
    const parsed = parseLedger(mine.body ?? '')
    if (parsed === null) return { ok: false, why: "its comment doesn't parse as a '## Pipeline Cost' table" }
    return { ok: true, rows: parsed.rows, seconds: parsed.rows.reduce((a, r) => a + r.seconds, 0), ref: mine.databaseId ?? null }
  }

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

  return { readLedger, issueForPr }
}
