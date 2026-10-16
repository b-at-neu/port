// The Board's own header — title, the Phase/Repo toggle, the repo filter,
// and Refresh. The freshness indicator renders below as its own strip.
import { RefreshCw } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/renderer/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { ScreenHeader } from '@/renderer/components/screen-header'
import type { RepoId } from '@/utils/repos'
import type { BoardSnapshot } from '@/types/board'
import type { RepositoryState } from '@/types/state'
import type { BoardGroupBy } from '@/types/board'
import { freshnessIndicator } from '@/renderer/board/copy'

interface BoardHeaderProps {
  readonly snapshot: BoardSnapshot | null
  readonly refreshing: boolean
  readonly onRefresh: () => void
  readonly group: BoardGroupBy
  readonly onGroupChange: (group: BoardGroupBy) => void
  readonly repo: RepoId | null
  readonly onRepoChange: (repo: RepoId | null) => void
}

export function BoardHeader({ snapshot, refreshing, onRefresh, group, onGroupChange, repo, onRepoChange }: BoardHeaderProps) {
  const readyRepos = snapshot !== null ? snapshot.state.repositories.filter((r): r is Extract<RepositoryState, { readonly ok: true }> => r.ok) : []

  return (
    <ScreenHeader className="justify-between gap-2">
      <span>Board</span>
      <div className="flex items-center gap-2">
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
    </ScreenHeader>
  )
}

export function FreshnessStrip({ snapshot, now }: { readonly snapshot: BoardSnapshot; readonly now: Date }) {
  const indicator = freshnessIndicator(snapshot, now)
  if (indicator === null) return null

  return (
    <div className="border-b border-border px-4 py-2">
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
    </div>
  )
}
