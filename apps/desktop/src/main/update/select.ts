import { compareVersions, isDevVersion, normalizeVersion, parseVersion, type ParsedVersion } from '@/utils/release/version'

import type { AppRelease, UpdateClassification, UpdateGate } from '@/types/update'

/** The highest stable release; a draft, a prerelease flag or a prerelease-shaped tag never qualifies. Ties keep the first, which the API lists newest. */
export function selectLatestRelease(releases: readonly AppRelease[]): AppRelease | null {
  let best: { release: AppRelease; version: ParsedVersion } | null = null
  for (const release of releases) {
    if (release.draft || release.prerelease) continue
    const version = parseVersion(release.tag)
    if (version === null || version.prerelease !== null) continue
    if (best === null || compareVersions(version, best.version) > 0) best = { release, version }
  }
  return best?.release ?? null
}

/** Running ahead of the latest release counts as up to date, never as an update. */
export function classifyUpdate(current: ParsedVersion, latest: AppRelease | null): UpdateClassification {
  const version = latest === null ? null : parseVersion(latest.tag)
  if (latest === null || version === null || compareVersions(version, current) <= 0) {
    return { kind: 'up-to-date', latest: latest === null ? null : normalizeVersion(latest.tag) }
  }
  return {
    kind: 'available',
    release: { version: normalizeVersion(latest.tag) ?? latest.tag, tag: latest.tag, notesUrl: latest.notesUrl, publishedAt: latest.publishedAt, assets: latest.assets },
  }
}

/** Decides before any I/O whether this build checks for updates at all. */
export function checkGate(params: { readonly isPackaged: boolean; readonly version: string }): UpdateGate {
  if (!params.isPackaged) return { ok: false, reason: 'unpackaged' }
  if (isDevVersion(params.version)) return { ok: false, reason: 'dev-build' }
  const current = parseVersion(params.version)
  return current === null ? { ok: false, reason: 'unparseable-version' } : { ok: true, current }
}
