// The in-app update, end to end over the real service and downloader: the releases GitHub publishes in, the state the screen shows and the installer opened out.
import { describe, expect, it } from 'vitest'
import type { FileDownload, FileDownloadResult } from '@/types/update'
import type { GitHubHttpResult } from '@/types/platform'
import { createUpdate } from '@/main/features/update/create'
import { callAction, createTestContext } from '../support/context'
import { createFakeClock, fakeUpdates } from '../support/fake-platform'

const REPO = 'octo/port'
const INSTALLER = 'port-1.5.0-linux-amd64.deb'
const releaseOf = (tag: string, assets: readonly { name: string; size: number }[] = []) => ({
  tag_name: tag,
  html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  published_at: '2026-08-01T00:00:00Z',
  assets: assets.map((asset) => ({ name: asset.name, size: asset.size, browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/${asset.name}`, content_type: 'application/octet-stream' })),
})
const published = (...releases: unknown[]): GitHubHttpResult => ({ ok: true, status: 200, headers: {}, body: JSON.stringify(releases) })

function updateRig(options: { readonly version?: string; readonly feed: GitHubHttpResult; readonly download?: FileDownload }) {
  const clock = createFakeClock()
  const updates = fakeUpdates({ downloadsDir: () => '/downloads', download: options.download })
  const platform = { info: () => ({ app: options.version ?? '1.4.0', electron: '0', node: '0', chromium: '0', commit: null }), updates, githubPublic: () => Promise.resolve(options.feed), clock }
  const update = createUpdate(platform, { confirm: () => Promise.resolve(true), cancel: () => undefined })
  const ctx = createTestContext({ platform: { ...platform, updates }, live: { update } })
  return { ctx, updates }
}

const saved = (bytes: number): FileDownload => (request): Promise<FileDownloadResult> => Promise.resolve({ ok: true, path: request.savePath, receivedBytes: bytes })

describe('updating the app', () => {
  it('finds a newer release, downloads its installer for this install and opens it', async () => {
    const app = updateRig({ feed: published(releaseOf('v1.5.0', [{ name: INSTALLER, size: 900 }]), releaseOf('v1.4.0')), download: saved(900) })

    expect(await callAction(app.ctx, 'update.check')).toMatchObject({ kind: 'available', release: { version: '1.5.0' } })
    expect(await callAction(app.ctx, 'update.download')).toMatchObject({ kind: 'ready', version: '1.5.0', assetName: INSTALLER, opened: 'opened' })
    expect(app.updates.downloads.map((download) => download.url)).toEqual([`https://github.com/${REPO}/releases/download/v1.5.0/${INSTALLER}`])
    expect(app.updates.opened).toEqual([`/downloads/${INSTALLER}`])
    expect(await callAction(app.ctx, 'update.downloadState')).toMatchObject({ kind: 'ready' })
  })

  it('reveals the downloaded installer instead of opening it again when asked', async () => {
    const app = updateRig({ feed: published(releaseOf('v1.5.0', [{ name: INSTALLER, size: 900 }])), download: saved(900) })
    await callAction(app.ctx, 'update.check')
    await callAction(app.ctx, 'update.download')

    await callAction(app.ctx, 'update.open', { reveal: true })
    expect(app.updates.revealed).toEqual([`/downloads/${INSTALLER}`])
  })

  it('says it is up to date when the newest release is the one running', async () => {
    const app = updateRig({ feed: published(releaseOf('v1.4.0')) })

    expect(await callAction(app.ctx, 'update.check')).toMatchObject({ kind: 'up-to-date', latest: '1.4.0' })
    expect(app.updates.downloads).toHaveLength(0)
  })

  it('offers no installer when the release carries none for this install', async () => {
    const app = updateRig({ feed: published(releaseOf('v1.5.0', [{ name: 'port-1.5.0-mac-arm64.dmg', size: 900 }])) })
    await callAction(app.ctx, 'update.check')

    expect(await callAction(app.ctx, 'update.download')).toMatchObject({ kind: 'no-asset', version: '1.5.0' })
    expect(app.updates.downloads).toHaveLength(0)
  })

  it('reports a truncated download as failed and opens nothing', async () => {
    const app = updateRig({ feed: published(releaseOf('v1.5.0', [{ name: INSTALLER, size: 900 }])), download: saved(400) })
    await callAction(app.ctx, 'update.check')

    expect(await callAction(app.ctx, 'update.download')).toMatchObject({ kind: 'failed', reason: 'incomplete' })
    expect(app.updates.opened).toHaveLength(0)
  })

  it('shows an error, not a stale answer, when GitHub cannot be reached', async () => {
    const app = updateRig({ feed: { ok: false, kind: 'timeout' } as GitHubHttpResult })

    expect(await callAction(app.ctx, 'update.check')).toMatchObject({ kind: 'error', reason: 'offline' })
  })

  it('never checks a development build', async () => {
    const app = updateRig({ version: '1.4.0-dev', feed: published(releaseOf('v1.5.0')) })

    expect(await callAction(app.ctx, 'update.check')).toMatchObject({ kind: 'disabled', reason: 'dev-build' })
  })
})
