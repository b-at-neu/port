// A previous release in the detail pane: header, notes, then the tickets it included.
import { ExternalLink } from 'lucide-react'
import { DetailPane } from '@/renderer/components/detail-pane'
import { Markdown } from '@/renderer/components/markdown'
import { Button } from '@/renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { exactTime, relativeAge } from '@/renderer/backlog/group'
import type { ReleaseInfo } from '@/types/release'
import type { RepoId } from '@/utils/repos'
import { NOTES_EMPTY, NOTES_LABEL, OPEN_ON_GITHUB } from '@/renderer/releases/copy'
import { ReleaseIssues } from '@/renderer/releases/release-issues'

interface ReleasePaneProps {
  readonly release: ReleaseInfo
  readonly repoId: RepoId
  readonly now: Date
  readonly onClose: () => void
}

export function ReleasePane({ release, repoId, now, onClose }: ReleasePaneProps) {
  return (
    <DetailPane onClose={onClose} data-slot="release-pane">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 truncate font-mono text-title font-semibold text-foreground">{release.tagName}</h2>
        {release.publishedAt !== null ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0 text-meta text-muted-foreground">{relativeAge(release.publishedAt, now)}</span>
            </TooltipTrigger>
            <TooltipContent>{exactTime(release.publishedAt)}</TooltipContent>
          </Tooltip>
        ) : null}
        <Button variant="ghost" size="small" className="ml-auto shrink-0" onClick={() => window.open(release.url, '_blank', 'noreferrer')}>
          <ExternalLink aria-hidden="true" className="size-3.5" />
          {OPEN_ON_GITHUB}
        </Button>
      </div>
      <p className="text-meta font-medium text-muted-foreground">{NOTES_LABEL}</p>
      {release.description.trim() === '' ? <p className="text-small text-muted-foreground">{NOTES_EMPTY}</p> : <Markdown source={release.description} className="text-small" />}
      <ReleaseIssues key={`${repoId}:${release.tagName}`} repoId={repoId} release={release} />
    </DetailPane>
  )
}
