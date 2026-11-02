// The "Allow from now on" read: the integration head and the two `.claude/` files at that exact oid, plus any open pull request already proposing the rule. Any failed read fails the whole read — a partial one would enable a write.
import { gh as defaultGh } from '@/main/platform/gh'
import type { BranchHead } from '@/types/release'
import type { AllowBaseRead, ReadAllowBaseParams } from '@/types/stage'
import { describe } from '@/main/github/release'
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
  return typeof first?.number === 'number' && typeof first.url === 'string' ? { number: first.number, url: first.url } : null
}

/** `readAllowBase({ repo, integration, branch })` — files are read at the head's oid, never the branch name, so they and the commit's parent agree. A 404 on `.claude/settings.json` reads as `null`. */
export async function readAllowBase(params: ReadAllowBaseParams): Promise<AllowBaseRead> {
  if (!SAFE_REF.test(params.integration)) return { ok: false, message: `${params.integration} isn't a branch name port will read` }
  const runner = params.gh ?? defaultGh
  const slug = `${params.repo.owner}/${params.repo.name}`

  const headRead = await runner(['api', `repos/${slug}/commits/${params.integration}`])
  if (!headRead.ok) return { ok: false, message: describe(headRead) }
  const head = headOf(parse(headRead.stdout))
  if (head === null) return { ok: false, message: "GitHub's commit read wasn't the expected shape" }

  const config = await runner(['api', `repos/${slug}/contents/${CONFIG_PATH}?ref=${head.oid}`, '-H', 'Accept: application/vnd.github.raw'])
  if (!config.ok) return { ok: false, message: `${CONFIG_PATH}: ${describe(config)}` }

  const settings = await runner(['api', `repos/${slug}/contents/${SETTINGS_PATH}?ref=${head.oid}`, '-H', 'Accept: application/vnd.github.raw'])
  if (!settings.ok && settings.kind !== 'http-not-found') return { ok: false, message: `${SETTINGS_PATH}: ${describe(settings)}` }

  const prs = await runner(['pr', 'list', '--repo', slug, '--head', params.branch, '--base', params.integration, '--state', 'open', '--json', 'number,url'])
  if (!prs.ok) return { ok: false, message: describe(prs) }
  return { ok: true, head, settingsText: settings.ok ? settings.stdout : null, configText: config.stdout, openPr: prOf(parse(prs.stdout)) }
}
