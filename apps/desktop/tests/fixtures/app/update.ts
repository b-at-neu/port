// The update channels' canned state, one consistent answer per scenario.
import type { FixtureScenario } from '@/types/fixtures'
import type { UpdateDownloadState, UpdateState, UpdateTrigger } from '@/types/update'

const CURRENT = '0.1.0'
const MB = 1024 * 1024
const NOTES_URL = 'https://github.com/acme/port/releases/tag/v0.2.0'
const ASSET_NAME = 'port-0.2.0-mac-arm64.dmg'

export function fixtureUpdateState(now: Date, scenario: FixtureScenario, trigger: UpdateTrigger): UpdateState {
  const checkedAt = new Date(now.getTime() - 2 * 60_000).toISOString()
  if (scenario === 'update-available' || scenario === 'update-downloading' || scenario === 'update-download-failed') {
    return {
      kind: 'available',
      current: CURRENT,
      trigger,
      checkedAt,
      release: {
        version: '0.2.0',
        tag: 'v0.2.0',
        notesUrl: NOTES_URL,
        publishedAt: checkedAt,
        assets: [{ name: ASSET_NAME, url: `https://github.com/acme/port/releases/download/v0.2.0/${ASSET_NAME}`, size: 120 * MB, contentType: 'application/x-apple-diskimage' }],
      },
    }
  }
  if (scenario === 'failing') return { kind: 'error', current: CURRENT, reason: 'offline', detail: 'fetch failed', trigger, checkedAt }
  if (scenario === 'registry-error') return { kind: 'checking', current: CURRENT, trigger, startedAt: checkedAt }
  return { kind: 'up-to-date', current: CURRENT, latest: CURRENT, trigger, checkedAt }
}

export function fixtureUpdateDownload(now: Date, scenario: FixtureScenario): UpdateDownloadState {
  const at = new Date(now.getTime() - 30_000).toISOString()
  if (scenario === 'update-downloading') {
    return { kind: 'downloading', version: '0.2.0', notesUrl: NOTES_URL, assetName: ASSET_NAME, receivedBytes: 54 * MB, totalBytes: 120 * MB, startedAt: at }
  }
  if (scenario === 'update-download-failed') {
    return { kind: 'failed', version: '0.2.0', notesUrl: NOTES_URL, assetName: ASSET_NAME, reason: 'interrupted', detail: 'interrupted', failedAt: at }
  }
  return { kind: 'idle' }
}
