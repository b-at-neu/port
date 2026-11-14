import type { ParsedVersion } from '@/utils/release/version'

export type UpdateTrigger = 'startup' | 'manual'

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

export type InstallPackage = 'dmg' | 'nsis' | 'appimage' | 'deb'

export interface InstallTarget {
  readonly os: 'mac' | 'win' | 'linux'
  readonly arch: 'x64' | 'arm64'
  readonly package: InstallPackage
}

export type UpdateDownloadErrorKind = 'interrupted' | 'incomplete' | 'unavailable'

export type UpdateDownloadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'no-asset'; readonly version: string; readonly notesUrl: string; readonly target: InstallTarget | null }
  | { readonly kind: 'downloading'; readonly version: string; readonly notesUrl: string; readonly assetName: string; readonly receivedBytes: number; readonly totalBytes: number; readonly startedAt: string }
  | {
      readonly kind: 'ready'
      readonly version: string
      readonly notesUrl: string
      readonly assetName: string
      readonly path: string
      readonly package: InstallPackage
      readonly opened: 'opened' | 'revealed'
      readonly openError: string | null
      readonly finishedAt: string
    }
  | { readonly kind: 'failed'; readonly version: string; readonly notesUrl: string; readonly assetName: string; readonly reason: UpdateDownloadErrorKind; readonly detail: string; readonly failedAt: string }

export interface FileDownloadRequest {
  readonly url: string
  readonly savePath: string
  readonly onProgress: (received: number, total: number) => void
}

export type FileDownloadResult =
  | { readonly ok: true; readonly path: string; readonly receivedBytes: number }
  | { readonly ok: false; readonly reason: 'interrupted'; readonly detail: string }

export type FileDownload = (request: FileDownloadRequest) => Promise<FileDownloadResult>

export interface UpdateDownloader {
  /** The cached state; does no I/O. */
  readonly state: () => UpdateDownloadState
  /** Starts or joins a download and resolves with its terminal state; never rejects. */
  readonly start: () => Promise<UpdateDownloadState>
  /** Opens the downloaded installer again, or shows it in its folder; acts only in `ready`. */
  readonly open: (reveal: boolean) => Promise<UpdateDownloadState>
}

/** What `DownloadControls` renders for one release and download state. */
export interface UpdateDownloadView {
  readonly kind: UpdateDownloadState['kind']
  readonly title: string
  readonly hint: string | null
  /** `null` while the total is unknown. */
  readonly percent: number | null
  readonly progressText: string | null
  readonly railLabel: string
  /** What a rail click runs; `null` while downloading. */
  readonly railAction: UpdateDownloadAction | null
  readonly buttons: readonly UpdateDownloadButton[]
  /** The text of the link beside the buttons; it opens the release page. */
  readonly linkLabel: string | null
}

export type UpdateDownloadAction = 'download' | 'open' | 'reveal' | 'open-page'

export interface UpdateDownloadButton {
  readonly action: UpdateDownloadAction
  readonly label: string
  readonly variant: 'default' | 'outline'
}

/** What the sidebar notice and the collapsed rail button show for an available release. */
export interface UpdateNoticeView {
  readonly version: string
  readonly notesUrl: string
  readonly release: AvailableRelease
}

/** The Settings → About status line: one row per `UpdateState` kind. */
export interface UpdateStatusView {
  readonly kind: UpdateState['kind']
  readonly text: string
  readonly checkedAgo: string | null
  readonly release: AvailableRelease | null
  readonly canCheck: boolean
}

export type UpdateState =
  | { readonly kind: 'disabled'; readonly reason: 'unpackaged' | 'dev-build' | 'unparseable-version'; readonly current: string }
  | { readonly kind: 'idle'; readonly current: string }
  | { readonly kind: 'checking'; readonly current: string; readonly trigger: UpdateTrigger; readonly startedAt: string }
  | { readonly kind: 'up-to-date'; readonly current: string; readonly latest: string | null; readonly trigger: UpdateTrigger; readonly checkedAt: string }
  | { readonly kind: 'available'; readonly current: string; readonly release: AvailableRelease; readonly trigger: UpdateTrigger; readonly checkedAt: string }
  | { readonly kind: 'error'; readonly current: string; readonly reason: UpdateErrorKind; readonly detail: string; readonly trigger: UpdateTrigger; readonly checkedAt: string }
