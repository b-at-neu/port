// The Board's own header — title, the always-on GitHub timing label, the
// repo filter, and Refresh — all on one line.
import { Columns3, List, RefreshCw } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/renderer/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { ScreenHeader } from '@/renderer/components/screen-header'
import { cn } from '@/renderer/lib/utils'
import type { RepoId } from '@/utils/repos'
import type { BoardSnapshot } from '@/types/board'
import type { BoardView } from '@/types/router'
import type { RepositoryState } from '@/types/state'
import { boardLayoutLabel, boardViewLabel, freshnessIndicator } from '@/renderer/board/copy'

interface BoardHeaderProps {
  readonly snapshot: BoardSnapshot | null
  readonly now: Date
  readonly refreshing: boolean
  readonly onRefresh: () => void
  readonly repo: RepoId | null
  readonly onRepoChange: (repo: RepoId | null) => void
  readonly view: BoardView
  readonly onViewChange: (view: BoardView) => void
}

export function BoardHeader({ snapshot, now, refreshing, onRefresh, repo, onRepoChange, view, onViewChange }: BoardHeaderProps) {
  const readyRepos = snapshot !== null ? snapshot.state.repositories.filter((r): r is Extract<RepositoryState, { readonly ok: true }> => r.ok) : []
  const indicator = snapshot !== null ? freshnessIndicator(snapshot, now) : null

  return (
    <ScreenHeader className="justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0">Board</span>
        {indicator !== null ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className={cn('truncate text-meta font-normal', indicator.tone === 'attention' ? 'text-attention-dot' : 'text-muted-foreground')}>
                {indicator.label}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {indicator.lines.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Tabs value={view} onValueChange={(value) => onViewChange(value as BoardView)}>
          <TabsList aria-label={boardLayoutLabel()} className="text-foreground-secondary">
            <TabsTrigger value="list">
              <List aria-hidden="true" className="size-4" />
              {boardViewLabel('list')}
            </TabsTrigger>
            <TabsTrigger value="board">
              <Columns3 aria-hidden="true" className="size-4" />
              {boardViewLabel('board')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Select value={repo ?? 'all'} onValueChange={(value) => onRepoChange(value === 'all' ? null : (value as RepoId))}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All repositories</SelectItem>
            {readyRepos.map((r) => (
              <SelectItem key={r.repoId} value={r.repoId}>
                {r.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="small" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw aria-hidden="true" className={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'} />
          Refresh
        </Button>
      </div>
    </ScreenHeader>
  )
}
