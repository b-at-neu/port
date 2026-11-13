import { describe, expect, it } from 'vitest'
import { fetchAppReleases } from '@/main/github/app-releases'
import type { GitHubHttpResult, GitHubRequest } from '@/types/platform'

const REPO = { owner: 'octo', name: 'port' }

function transportOf(result: GitHubHttpResult, seen: GitHubRequest[] = []) {
  return (request: GitHubRequest) => {
    seen.push(request)
    return Promise.resolve(result)
  }
}

const okBody = (body: unknown): GitHubHttpResult => ({ ok: true, status: 200, headers: {}, body: typeof body === 'string' ? body : JSON.stringify(body) })

const failure = (kind: 'network' | 'rate-limited' | 'forbidden' | 'http-not-found' | 'unauthenticated' | 'unknown', status: number | null): GitHubHttpResult => ({
  ok: false,
  kind,
  status,
  body: '',
  message: `GitHub: ${kind}`,
})

describe('fetchAppReleases', () => {
  it('requests the repository releases list', async () => {
    const seen: GitHubRequest[] = []
    await fetchAppReleases(REPO, transportOf(okBody([]), seen))
    expect(seen).toEqual([{ method: 'GET', path: 'repos/octo/port/releases?per_page=30' }])
  })

  it.each<[string, GitHubHttpResult, string]>([
    ['an unreachable network', failure('network', null), 'offline'],
    ['a timeout', { ok: false, kind: 'timeout', timeoutMs: 1, stderr: '' }, 'offline'],
    ['a 403 rate limit', failure('rate-limited', 403), 'rate-limited'],
    ['a 429', failure('rate-limited', 429), 'rate-limited'],
    ['a 5xx', failure('network', 503), 'unavailable'],
    ['a plain 403', failure('forbidden', 403), 'unavailable'],
    ['a 404', failure('http-not-found', 404), 'unavailable'],
    ['a 401', failure('unauthenticated', 401), 'unavailable'],
    ['an unknown status', failure('unknown', 418), 'unavailable'],
    ['an oversized body', { ok: false, kind: 'output-too-large', maxBytes: 1 }, 'unavailable'],
    ['a spawn failure', { ok: false, kind: 'spawn-failed', message: 'boom' }, 'unavailable'],
  ])('maps %s to %s', async (_label, result, reason) => {
    expect(await fetchAppReleases(REPO, transportOf(result))).toMatchObject({ ok: false, reason })
  })

  it('reports a non-JSON body and a non-array body as malformed', async () => {
    expect(await fetchAppReleases(REPO, transportOf(okBody('<html>')))).toMatchObject({ ok: false, reason: 'malformed' })
    expect(await fetchAppReleases(REPO, transportOf(okBody({ message: 'nope' })))).toMatchObject({ ok: false, reason: 'malformed' })
  })

  it('narrows entries and drops the ones missing a required field', async () => {
    const result = await fetchAppReleases(
      REPO,
      transportOf(
        okBody([
          {
            tag_name: 'v1.5.0',
            html_url: 'https://github.com/octo/port/releases/tag/v1.5.0',
            draft: false,
            prerelease: false,
            published_at: '2026-01-02T03:04:05Z',
            assets: [
              { name: 'port.dmg', browser_download_url: 'https://example.test/port.dmg', size: 10, content_type: 'application/x-apple-diskimage' },
              { name: 'no-url', size: 1 },
              { name: 'no-type.deb', browser_download_url: 'https://example.test/port.deb', size: 4 },
            ],
          },
          { tag_name: 'v1.4.0', html_url: 'u', draft: false },
          { html_url: 'u', draft: false, prerelease: false },
          'not an object',
          null,
        ]),
      ),
    )
    expect(result).toEqual({
      ok: true,
      releases: [
        {
          tag: 'v1.5.0',
          notesUrl: 'https://github.com/octo/port/releases/tag/v1.5.0',
          draft: false,
          prerelease: false,
          publishedAt: '2026-01-02T03:04:05Z',
          assets: [
            { name: 'port.dmg', url: 'https://example.test/port.dmg', size: 10, contentType: 'application/x-apple-diskimage' },
            { name: 'no-type.deb', url: 'https://example.test/port.deb', size: 4, contentType: null },
          ],
        },
      ],
    })
  })
})
