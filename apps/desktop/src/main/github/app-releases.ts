import { githubPublic } from '@/main/platform/github-http'

import type { GitHubHttpResult, GitHubTransport } from '@/types/platform'
import type { AppRelease, FetchReleasesResult, ReleaseAsset, UpdateErrorKind } from '@/types/update'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function failureOf(result: Exclude<GitHubHttpResult, { ok: true }>): { reason: UpdateErrorKind; detail: string } {
  if (result.kind === 'timeout') return { reason: 'offline', detail: 'the releases request timed out' }
  if (result.kind === 'network' && 'status' in result && result.status === null) return { reason: 'offline', detail: result.message }
  if (result.kind === 'rate-limited' && 'message' in result) return { reason: 'rate-limited', detail: result.message }
  return { reason: 'unavailable', detail: 'message' in result ? result.message : `the releases request failed (${result.kind})` }
}

function narrowAsset(value: unknown): ReleaseAsset | null {
  if (!isRecord(value)) return null
  const { name, browser_download_url: url, size, content_type: contentType } = value
  if (typeof name !== 'string' || typeof url !== 'string' || typeof size !== 'number') return null
  return { name, url, size, contentType: typeof contentType === 'string' ? contentType : null }
}

function narrowRelease(value: unknown): AppRelease | null {
  if (!isRecord(value)) return null
  const { tag_name: tag, html_url: notesUrl, draft, prerelease, published_at: publishedAt, assets } = value
  if (typeof tag !== 'string' || typeof notesUrl !== 'string' || typeof draft !== 'boolean' || typeof prerelease !== 'boolean') return null
  const narrowed = Array.isArray(assets) ? assets.map(narrowAsset).filter((asset): asset is ReleaseAsset => asset !== null) : []
  return { tag, notesUrl, draft, prerelease, publishedAt: typeof publishedAt === 'string' ? publishedAt : null, assets: narrowed }
}

/** The app's own public releases, newest first; every failure is a typed value, never a throw. */
export async function fetchAppReleases(repo: { readonly owner: string; readonly name: string }, transport: GitHubTransport = githubPublic): Promise<FetchReleasesResult> {
  const result = await transport({ method: 'GET', path: `repos/${repo.owner}/${repo.name}/releases?per_page=30` })
  if (!result.ok) return { ok: false, ...failureOf(result) }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.body)
  } catch {
    return { ok: false, reason: 'malformed', detail: 'the releases response was not JSON' }
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: 'malformed', detail: 'the releases response was not a list' }
  return { ok: true, releases: parsed.map(narrowRelease).filter((release): release is AppRelease => release !== null) }
}
