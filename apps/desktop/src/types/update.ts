import type { ParsedVersion } from '@/utils/release/version'

export type UpdateTrigger ='startup' | 'manual'

export type UpdateErrorKind = 'offline' | 'rate-limited' | 'malformed' | 'unavailable'

export interface ReleaseAsset {
  readonly name: string
  readonly url: string
  readonly size: number
  readonly contentType: string | null
}

/** A GitHub release narrowed to the fields the update check reads. */
export interface AppRelease {
  readonly tag: string
  readonly notesUrl: string
  readonly draft: boolean
  readonly prerelease: boolean
  readonly publishedAt: string | null
  readonly assets: readonly ReleaseAsset[]
}

export type FetchReleasesResult =
  | { readonly ok: true; readonly releases: readonly AppRelease[] }
  | { readonly ok: false; readonly reason: UpdateErrorKind; readonly detail: string }

export interface AvailableRelease {
  readonly version: string
  readonly tag: string
  readonly notesUrl: string
  readonly publishedAt: string | null
  readonly assets: readonly ReleaseAsset[]
}

export type UpdateGate =
  | { readonly ok: true; readonly current: ParsedVersion }
  | { readonly ok: false; readonly reason: 'unpackaged' | 'dev-build' | 'unparseable-version' }

export type UpdateClassification =
  | { readonly kind: 'up-to-date'; readonly latest: string | null }
  | { readonly kind: 'available'; readonly release: AvailableRelease }

export interface UpdateService {
  /** The cached state; does no I/O. */
  readonly state: () => UpdateState
  /** Runs or joins a check and resolves with its terminal state; never rejects. */
  readonly check: (trigger: UpdateTrigger) => Promise<UpdateState>
}

export type UpdateState =
  | { readonly kind: 'disabled'; readonly reason: 'unpackaged' | 'dev-build' | 'unparseable-version'; readonly current: string }
  | { readonly kind: 'idle'; readonly current: string }
  | { readonly kind: 'checking'; readonly current: string; readonly trigger: UpdateTrigger; readonly startedAt: string }
  | { readonly kind: 'up-to-date'; readonly current: string; readonly latest: string | null; readonly trigger: UpdateTrigger; readonly checkedAt: string }
  | { readonly kind: 'available'; readonly current: string; readonly release: AvailableRelease; readonly trigger: UpdateTrigger; readonly checkedAt: string }
  | { readonly kind: 'error'; readonly current: string; readonly reason: UpdateErrorKind; readonly detail: string; readonly trigger: UpdateTrigger; readonly checkedAt: string }
