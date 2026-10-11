// Polls session:changes every 5s while mounted, without useEffect.
import { FileDiff as FileDiffIcon, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DetailPane } from '../components/detail-pane'
import { DiffView } from '../components/diff-view'
import { EmptyState } from '../components/empty-state'
import { ErrorBanner } from '../components/error-banner'
import { useIpcQuery } from '../data/query'
import type { HostedSessionSnapshot, SessionKey } from '../../../shared/hosting/types'
import type { FileDiff } from '../../../shared/sessions/transcript'
import type { SessionChanges } from '../../../shared/workspace/types'
import { CLOSE_CHANGES, REFRESH_CHANGES, binaryLine, changesEmpty, changesErrorCopy, changesHeader, changesTooLarge, numstatLine, untrackedLine } from './changes-copy'

function sortedFiles(files: readonly FileDiff[]): readonly FileDiff[] {
  return [...files].sort((a, b) => a.path.localeCompare(b.path))
}

export function ChangesPane({ snapshot, onClose }: { readonly snapshot: HostedSessionSnapshot; readonly onClose: () => void }) {
  const sessionKey: SessionKey = snapshot.sessionKey
  const query = useIpcQuery('session:changes', { sessionKey }, { refetchInterval: 5000 })
  const data = query.data
  const baseSha = snapshot.workspace.base?.sha ?? null
  const header = data?.ok === true ? changesHeader(data.base ?? { sha: '' }, snapshot.workspace.worktree?.branch ?? null) : null

  return (
    <DetailPane onClose={onClose} data-slot="changes-pane">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 truncate text-small text-foreground-secondary">
          {header !== null ? (
            <>
              {header.prefix} {header.branch !== null ? <span className="font-mono">{header.branch}</span> : null}
              {header.branch !== null ? ' base · ' : ' '}
              {header.sha}
            </>
          ) : (
            'Changes'
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="small" aria-label={REFRESH_CHANGES} onClick={() => void query.refetch()}>
                <RefreshCw aria-hidden="true" className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{REFRESH_CHANGES}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="small" aria-label={CLOSE_CHANGES} onClick={onClose}>
                <X aria-hidden="true" className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{CLOSE_CHANGES}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {query.isError ? (
        <ErrorBanner message={changesErrorCopy('unreachable', baseSha)} />
      ) : data === undefined ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </div>
      ) : data.ok === false ? (
        <ErrorBanner message={changesErrorCopy(data, baseSha)} />
      ) : (
        <ChangesBody changes={data} />
      )}
    </DetailPane>
  )
}

function ChangesBody({ changes }: { readonly changes: Extract<SessionChanges, { readonly ok: true }> }) {
  const files = sortedFiles(changes.files)
  const hasUntracked = changes.untracked.length > 0
  const hasBinary = changes.binary.length > 0

  if (changes.truncated) {
    return (
      <div className="flex flex-col gap-3">
        <ErrorBanner message={changesTooLarge(changes.summary.length + changes.binary.length)} />
        <div className="flex flex-col gap-1 font-mono text-meta">
          {changes.summary.map((entry) => {
            const numstat = numstatLine(entry)
            return (
              <div key={entry.path} className="truncate">
                <span className="text-diff-added-foreground">{numstat.added}</span> <span className="text-diff-removed-foreground">{numstat.removed}</span> {entry.path}
              </div>
            )
          })}
        </div>
        <ChangesLists untracked={changes.untracked} binary={changes.binary} />
      </div>
    )
  }

  if (files.length === 0 && !hasUntracked && !hasBinary) {
    return <EmptyState icon={FileDiffIcon} message={changesEmpty(changes.base?.sha ?? '')} />
  }

  return (
    <div className="flex flex-col gap-3">
      {files.map((file) => (
        <DiffView key={file.path} diff={file} />
      ))}
      <ChangesLists untracked={changes.untracked} binary={changes.binary} />
    </div>
  )
}

function ChangesLists({ untracked, binary }: { readonly untracked: readonly string[]; readonly binary: readonly string[] }) {
  if (untracked.length === 0 && binary.length === 0) return null
  return (
    <div className="flex flex-col gap-0.5 font-mono text-meta text-muted-foreground">
      {untracked.map((path) => (
        <div key={path} className="truncate">
          {untrackedLine(path)}
        </div>
      ))}
      {binary.map((path) => (
        <div key={path} className="truncate">
          {binaryLine(path)}
        </div>
      ))}
    </div>
  )
}
