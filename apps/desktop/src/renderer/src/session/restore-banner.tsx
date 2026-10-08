// The restore banner — offered once at boot when `session:restore:list` returns entries.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useIpcMutation, useIpcQuery } from '../data/query'
import type { RestorableSession } from '../../../shared/hosting/types'
import type { RepositoryEntry } from '../../../shared/repos'
import { adoptSession, selectSession } from './actions'
import { startFailureCopy } from './copy'
import { RESTORE_DISMISS, RESTORE_FORGET, RESTORE_RESUME_ALL, RESTORE_RESUME_ONE, RESTORE_REVIEW, restoreBannerLine, restoreOpenedLine, restorePartialLine, restoreUnavailableLine } from './rail-copy'

function repoLabelFor(repos: readonly RepositoryEntry[] | undefined, repoId: string): string {
  const entry = repos?.find((candidate) => candidate.id === repoId)
  if (entry === undefined) return repoId
  return 'config' in entry ? entry.config.repo : entry.displayName
}

export function RestoreBanner() {
  const query = useIpcQuery('session:restore:list')
  const repos = useIpcQuery('repos:list')
  const restoreOne = useIpcMutation('session:restore')
  const discard = useIpcMutation('session:restore:discard')
  const [reviewing, setReviewing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const entries = query.data?.entries ?? []
  if (entries.length === 0) return null

  async function resumeOne(entry: RestorableSession): Promise<void> {
    try {
      const result = await restoreOne.mutateAsync({ restoreId: entry.restoreId })
      if (result.ok) {
        adoptSession(result.snapshot)
        selectSession(result.snapshot.sessionKey)
      } else if (result.kind === 'already-open') {
        selectSession(result.sessionKey)
      } else if (result.kind === 'at-capacity') {
        setNotice(`Port is already hosting ${String(result.limit)} sessions — the limit. Close one or raise the limit to resume this one.`)
      } else if (result.kind === 'repo-unavailable') {
        setNotice(`This repository isn't ready — ${result.reason}`)
      } else if (result.kind === 'runtime') {
        setNotice(startFailureCopy(result).body)
      }
    } catch (error) {
      console.error('Failed to reach the main process restoring a session', error)
    }
    void query.refetch()
  }

  async function resumeAll(): Promise<void> {
    const candidates = entries.filter((entry) => entry.availability.ok)
    let resumed = 0
    for (const entry of candidates) {
      try {
        const result = await restoreOne.mutateAsync({ restoreId: entry.restoreId })
        if (result.ok) {
          resumed += 1
          adoptSession(result.snapshot)
        } else if (result.kind === 'already-open') {
          resumed += 1
        } else if (result.kind === 'at-capacity') {
          setNotice(restorePartialLine(resumed, candidates.length, result.limit))
          void query.refetch()
          return
        }
      } catch (error) {
        console.error('Failed to reach the main process resuming a session', error)
        void query.refetch()
        return
      }
    }
    void query.refetch()
  }

  async function forget(restoreId: string): Promise<void> {
    try {
      await discard.mutateAsync({ restoreId })
    } catch (error) {
      console.error('Failed to reach the main process forgetting a restorable session', error)
    }
    void query.refetch()
  }

  async function dismiss(): Promise<void> {
    try {
      await discard.mutateAsync({ restoreId: null })
    } catch (error) {
      console.error('Failed to reach the main process dismissing the restore banner', error)
    }
    setReviewing(false)
    void query.refetch()
  }

  const now = new Date()

  return (
    <div aria-live="polite" className="flex flex-col gap-2 rounded-lg bg-attention-pill px-3 py-2 text-small text-attention-pill-foreground">
      <p>{restoreBannerLine(entries.length)}</p>
      {notice !== null ? <p className="text-meta">{notice}</p> : null}
      <div className="flex gap-2">
        <Button size="small" variant="outline" onClick={() => void resumeAll()}>
          {RESTORE_RESUME_ALL}
        </Button>
        <Button size="small" variant="outline" onClick={() => setReviewing((value) => !value)}>
          {RESTORE_REVIEW}
        </Button>
        <Button size="small" variant="outline" onClick={() => void dismiss()}>
          {RESTORE_DISMISS}
        </Button>
      </div>
      {reviewing ? (
        <div className="flex flex-col gap-2">
          {entries.map((entry) => {
            const label = entry.title ?? `Resumed session ${entry.origin.from.slice(0, 8)}`
            return (
              <div key={entry.restoreId} className="flex items-center justify-between gap-2 rounded-md bg-background/50 px-2 py-1">
                <div className="flex flex-col">
                  <span className="text-foreground">
                    {repoLabelFor(repos.data?.ok === true ? repos.data.repositories : undefined, entry.repoId)} · {label}
                  </span>
                  <span className="text-meta">{restoreOpenedLine(entry.startedAt, now)}</span>
                  {!entry.availability.ok ? <span className="text-meta">{restoreUnavailableLine(entry.availability.reason)}</span> : null}
                </div>
                <div className="flex shrink-0 gap-1">
                  {entry.availability.ok ? (
                    <Button size="small" variant="outline" onClick={() => void resumeOne(entry)}>
                      {RESTORE_RESUME_ONE}
                    </Button>
                  ) : null}
                  <Button size="small" variant="outline" onClick={() => void forget(entry.restoreId)}>
                    {RESTORE_FORGET}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
