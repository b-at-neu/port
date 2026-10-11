// The Board's own header — title, freshness, the Phase/Repo toggle, the
// repo filter, Refresh, Plan gate, Work on ticket, and Halt everything.
import { useState, useSyncExternalStore } from 'react'
import { RefreshCw } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { RepoId } from '../../../shared/repos'
import type { BoardSnapshot, SourceKind } from '../../../shared/board/types'
import type { RepositoryState } from '../../../shared/state/types'
import { worstHealth } from '../../../shared/board/project'
import type { BoardGroupBy } from './sections'
import { haltButtonLabel, haltPending, runHalt, subscribeDispatch } from './dispatch'
import { rateLimitCopy, sourceHealthCopy } from './copy'
import { openClaimDialog } from '../claim/controller'

const SOURCE_KINDS: readonly SourceKind[] = ['github', 'sessions', 'worktrees', 'denials']

export interface BoardHeaderProps {
  readonly snapshot: BoardSnapshot | null
  readonly now: Date
  readonly refreshing: boolean
  readonly onRefresh: () => void
  readonly group: BoardGroupBy
  readonly onGroupChange: (group: BoardGroupBy) => void
  readonly repo: RepoId | null
  readonly onRepoChange: (repo: RepoId | null) => void
}

function FreshnessStrip({ snapshot, now }: { readonly snapshot: BoardSnapshot; readonly now: Date }) {
  if (snapshot.health.length === 0) return null
  const parts = SOURCE_KINDS.map((kind) => {
    const worst = worstHealth(snapshot.health, kind)
    return worst !== null ? sourceHealthCopy(kind, worst, now) : null
  })
  const rateLimit = snapshot.state.repositories.find((r): r is Extract<RepositoryState, { readonly ok: true }> => r.ok)?.rateLimit ?? null
  const rateLimitText = rateLimit !== null ? rateLimitCopy(null, rateLimit.remaining, rateLimit.resetAt) : null
  const line = [...parts, rateLimitText].filter((p): p is string => p !== null).join(' · ')
  if (line === '') return null
  return <div className="text-meta text-muted-foreground">{line}</div>
}

function HaltButton({ snapshot }: { readonly snapshot: BoardSnapshot }) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const inFlightCount = snapshot.tick.reduce((total, report) => total + report.claims.length, 0)
  const pending = useSyncExternalStore(subscribeDispatch, haltPending)
  if (inFlightCount === 0) return null

  return (
    <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="small" disabled={pending}>
          {haltButtonLabel(pending)}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Halt everything?</AlertDialogTitle>
          <AlertDialogDescription>Pauses every pipeline and stops {inFlightCount} in-flight items. Nothing is picked up until you run it again.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault()
              void runHalt().then(() => setConfirmOpen(false))
            }}
          >
            {pending ? 'Halting…' : 'Halt everything'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function BoardHeader({ snapshot, now, refreshing, onRefresh, group, onGroupChange, repo, onRepoChange }: BoardHeaderProps) {
  const readyRepos = snapshot !== null ? snapshot.state.repositories.filter((r): r is Extract<RepositoryState, { readonly ok: true }> => r.ok) : []

  return (
    <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-title font-semibold text-foreground">Board</h1>
        <div className="flex items-center gap-2">
          {snapshot !== null && hasStaleSource(snapshot, now) ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-meta text-attention-dot">Updated {staleAgeCopy(snapshot, now)}</span>
              </TooltipTrigger>
              <TooltipContent>
                {SOURCE_KINDS.map((kind) => {
                  const worst = worstHealth(snapshot.health, kind)
                  return worst !== null ? <div key={kind}>{sourceHealthCopy(kind, worst, now)}</div> : null
                })}
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
          <Button size="small" onClick={openClaimDialog}>
            Work on ticket
          </Button>
          {snapshot !== null ? <HaltButton snapshot={snapshot} /> : null}
        </div>
      </div>
      {snapshot !== null ? <FreshnessStrip snapshot={snapshot} now={now} /> : null}
    </div>
  )
}

function hasStaleSource(snapshot: BoardSnapshot, now: Date): boolean {
  return snapshot.health.some((h) => {
    const last = h.github.lastSuccessAt
    if (last === null) return false
    return now.getTime() - Date.parse(last) > h.github.intervalMs * 2
  })
}

function staleAgeCopy(snapshot: BoardSnapshot, now: Date): string {
  const worst = worstHealth(snapshot.health, 'github')
  if (worst?.lastSuccessAt == null) return ''
  const seconds = Math.round((now.getTime() - Date.parse(worst.lastSuccessAt)) / 1000)
  const minutes = Math.round(seconds / 60)
  return minutes >= 1 ? `${String(minutes)}m ago` : `${String(seconds)}s ago`
}
