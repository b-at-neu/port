// The Board's own header — title, freshness indicator, the Phase/Repo
// toggle, the repo filter, and Refresh.
import { RefreshCw } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/renderer/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import type { RepoId } from '@/utils/repos'
import type { BoardSnapshot } from '@/types/board'
import type { RepositoryState } from '@/types/state'
import type { BoardGroupBy } from '@/types/board'
import { freshnessIndicator } from '@/renderer/board/copy'

interface BoardHeaderProps {
  readonly snapshot: BoardSnapshot | null
  readonly now: Date
  readonly refreshing: boolean
  readonly onRefresh: () => void
  readonly group: BoardGroupBy
  readonly onGroupChange: (group: BoardGroupBy) => void
  readonly repo: RepoId | null
  readonly onRepoChange: (repo: RepoId | null) => void
}

export function BoardHeader({ snapshot, now, refreshing, onRefresh, group, onGroupChange, repo, onRepoChange }: BoardHeaderProps) {
  const readyRepos = snapshot !== null ? snapshot.state.repositories.filter((r): r is Extract<RepositoryState, { readonly ok: true }> => r.ok) : []
  const indicator = snapshot !== null ? freshnessIndicator(snapshot, now) : null

  return (
    <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
      <h1 className="text-title font-semibold text-foreground">Board</h1>
      <div className="flex items-center gap-2">
        {indicator !== null ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="text-meta text-attention-dot">
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
        <Tabs value={group} onValueChange={(value) => onGroupChange(value as BoardGroupBy)}>
          <TabsList>
            <TabsTrigger value="phase">Phase</TabsTrigger>
            <TabsTrigger value="repo">Repo</TabsTrigger>
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
    </div>
  )
}
