// The "Allow from now on" read: the integration head and the two `.claude/` files at that exact oid, plus any open pull request already proposing the rule. Any failed read fails the whole read — a partial one would enable a write.
import { githubHttp } from '@/main/platform/github-http'
import type { BranchHead } from '@/types/release'
import type { AllowBaseRead, ReadAllowBaseParams } from '@/types/stage'
import { describeHttp } from '@/main/github/envelope'
import { RAW_ACCEPT, restRequest } from '@/main/github/request'
import { CONFIG_PATH, SETTINGS_PATH } from '@/main/stage/allowlist'

const SAFE_REF = /^[A-Za-z0-9._/-]+$/

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function obj(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : null
}

function headOf(body: unknown): BranchHead | null {
  const commit = obj(body)
  const oid = commit?.sha
  const tree = obj(obj(commit?.commit)?.tree)?.sha
  return typeof oid === 'string' && typeof tree === 'string' ? { oid, tree } : null
}

function prOf(list: unknown): { readonly number: number; readonly url: string } | null {
  const first = Array.isArray(list) ? obj(list[0] as unknown) : null
  return typeof first?.number === 'number' && typeof first.html_url === 'string' ? { number: first.number, url: first.html_url } : null
}

/** `readAllowBase({ repo, integration, branch })` — files are read at the head's oid, never the branch name, so they and the commit's parent agree. A 404 on `.claude/settings.json` reads as `null`. */
export async function readAllowBase(params: ReadAllowBaseParams): Promise<AllowBaseRead> {
  if (!SAFE_REF.test(params.integration)) return { ok: false, message: `${params.integration} isn't a branch name port will read` }
  const github = params.github ?? githubHttp
  const slug = `${params.repo.owner}/${params.repo.name}`

  const headRead = await github(restRequest(`repos/${slug}/commits/${params.integration}`))
  if (!headRead.ok) return { ok: false, message: describeHttp(headRead) }
  const head = headOf(parse(headRead.body))
  if (head === null) return { ok: false, message: "GitHub's commit read wasn't the expected shape" }

  const config = await github(restRequest(`repos/${slug}/contents/${CONFIG_PATH}?ref=${head.oid}`, RAW_ACCEPT))
  if (!config.ok) return { ok: false, message: `${CONFIG_PATH}: ${describeHttp(config)}` }

  const settings = await github(restRequest(`repos/${slug}/contents/${SETTINGS_PATH}?ref=${head.oid}`, RAW_ACCEPT))
  if (!settings.ok && settings.kind !== 'http-not-found') return { ok: false, message: `${SETTINGS_PATH}: ${describeHttp(settings)}` }

  const headRef = encodeURIComponent(`${params.repo.owner}:${params.branch}`)
  const prs = await github(restRequest(`repos/${slug}/pulls?head=${headRef}&base=${params.integration}&state=open&per_page=1`))
  if (!prs.ok) return { ok: false, message: describeHttp(prs) }
  return { ok: true, head, settingsText: settings.ok ? settings.body : null, configText: config.body, openPr: prOf(parse(prs.body)) }
}
