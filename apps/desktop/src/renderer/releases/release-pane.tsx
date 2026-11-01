// A previous release's notes in the detail pane.
import { ExternalLink } from 'lucide-react'
import { DetailPane } from '@/renderer/components/detail-pane'
import { Markdown } from '@/renderer/components/markdown'
import { Button } from '@/renderer/components/ui/button'
import type { ReleaseInfo } from '@/types/release'
import { NOTES_EMPTY, OPEN_ON_GITHUB } from '@/renderer/releases/copy'

export function ReleasePane({ release, onClose }: { readonly release: ReleaseInfo; readonly onClose: () => void }) {
  return (
    <DetailPane onClose={onClose} data-slot="release-pane">
      <h2 className="font-mono text-title font-semibold text-foreground">{release.tagName}</h2>
      {release.description.trim() === '' ? <p className="text-small text-muted-foreground">{NOTES_EMPTY}</p> : <Markdown source={release.description} className="text-small" />}
      <Button variant="outline" size="small" className="self-start" onClick={() => window.open(release.url, '_blank', 'noreferrer')}>
        <ExternalLink aria-hidden="true" className="size-3.5" />
        {OPEN_ON_GITHUB}
      </Button>
    </DetailPane>
  )
}
