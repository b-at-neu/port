// The transcript view's tail-poll error banner (#83, #84), split out of
// transcript.ts (#87) once the search screen's own wiring pushed that file
// past ENGINEERING §7's 500-line limit -- reaches the live view only through
// `getBannerHost()`, transcript.ts's one seam into its own private model.
import { getBannerHost, text } from './transcript'

export type TailBannerKind = 'not-found' | 'unreadable' | 'too-large' | 'unreachable'

function bannerCopy(kind: TailBannerKind, message: string, path: string | null): string {
  const p = path ?? ''
  switch (kind) {
    case 'not-found':
      return `The transcript file is gone — it may have been deleted. ${p}`
    case 'unreadable':
      return `Couldn't read ${p} — ${message}`
    case 'too-large':
      return `This transcript has grown past the 64 MB Port will read. Open it directly: ${p}`
    case 'unreachable':
      return 'Lost contact with the main process.'
  }
}

/** Shows an error banner above the rows already on screen -- nothing is
 *  ever wiped, since losing the transcript the operator is mid-read is
 *  worse than the error. `too-large` carries no `Retry`, since retrying
 *  cannot help. */
export function showTailBanner(kind: TailBannerKind, message: string, path: string | null): void {
  const bannerHost = getBannerHost()
  if (bannerHost === null) return
  bannerHost.textContent = ''
  const banner = document.createElement('div')
  banner.className = 'transcript-banner'
  banner.appendChild(text('p', 'transcript-banner__message', bannerCopy(kind, message, path)))
  if (kind !== 'too-large') {
    const retry = document.createElement('button')
    retry.className = 'transcript-banner__retry'
    retry.textContent = 'Retry'
    retry.dataset.action = 'retry-transcript'
    banner.appendChild(retry)
  }
  bannerHost.appendChild(banner)
}

export function clearTailBanner(): void {
  getBannerHost()?.replaceChildren()
}

/** `truncated` carries no banner -- the caller re-opens (a fresh
 *  `renderTranscript` call) and then calls this once, so the dim note
 *  survives that reset. */
export function showTruncatedNote(): void {
  const bannerHost = getBannerHost()
  if (bannerHost === null) return
  bannerHost.textContent = ''
  bannerHost.appendChild(text('p', 'transcript-note transcript-note--dim', 'This transcript was rewritten — reloaded from the start.'))
}
