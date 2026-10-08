// The Session screen — conversation, composer, and every UX state from the empty screen to ended.
import { useState } from 'react'
import { useSearch } from '@tanstack/react-router'
import { MessageSquare } from 'lucide-react'
import { AlertDialog, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '../components/empty-state'
import { ErrorBanner } from '../components/error-banner'
import { ScreenHeader } from '../components/screen-header'
import { Composer } from '../components/composer'
import { ConversationList } from '../components/conversation-list'
import { useIpcQuery } from '../data/query'
import { ROUTE_IDS } from '../router/routes'
import type { RepoId, RepositoryEntry } from '../../../shared/repos'
import type { HostedSessionSnapshot } from '../../../shared/hosting/types'
import { setSelectedSession } from './selection'
import { useSessionEntries } from './entries-store'
import { useDraft, setDraft } from './drafts'
import { close, dismiss, send, startNewSession, stop, usePendingStart, useStartFailure } from './actions'
import { SessionHeader } from './header'
import { EndPanel } from './end-panel'
import { CommandStrip } from './command-strip'
import { RestoreBanner } from './restore-banner'
import { COMPOSER_HINT, composerCopy, CLOSE_CONFIRM_NO, CLOSE_CONFIRM_PROMPT, EMPTY_TITLE, interruptNote, RECONNECTING, SEND_FAILED_UNKNOWN_SESSION, SEND_FAILED_UNREACHABLE, startingCopy, windowNote } from './copy'

function isReady(entry: RepositoryEntry): entry is Extract<RepositoryEntry, { status: 'ready' }> {
  return 'config' in entry
}

function repoLabelFor(repos: readonly RepositoryEntry[] | undefined, repoId: RepoId): string {
  const entry = repos?.find((candidate) => candidate.id === repoId)
  if (entry === undefined) return repoId
  return 'config' in entry ? entry.config.repo : entry.displayName
}

export function SessionScreen() {
  const search = useSearch({ from: ROUTE_IDS.session })
  const sessions = useIpcQuery('session:list')
  const repos = useIpcQuery('repos:list')
  const pendingStart = usePendingStart()
  const startFailure = useStartFailure()
  const key = search.key ?? null

  setSelectedSession(key)

  const snapshot = key !== null ? (sessions.data ?? []).find((candidate) => candidate.sessionKey === key) ?? null : null
  const readyRepos = repos.data?.ok === true ? repos.data.repositories.filter(isReady) : []

  return (
    <div className="flex h-full flex-col gap-3">
      <RestoreBanner />
      {snapshot !== null ? (
        <SessionLive key={snapshot.sessionKey} snapshot={snapshot} repoLabel={repoLabelFor(repos.data?.ok === true ? repos.data.repositories : undefined, snapshot.repoId)} />
      ) : pendingStart !== null ? (
        <StartingPanel repoLabel={pendingStart.repoLabel} />
      ) : startFailure !== null ? (
        <div className="flex flex-1 flex-col gap-2">
          <ScreenHeader>Session</ScreenHeader>
          <ErrorBanner message={`${startFailure.title}. ${startFailure.body}`} className="m-4" />
          {startFailure.detail !== null ? <pre className="mx-4 overflow-x-auto rounded-md bg-muted p-2 font-mono text-meta whitespace-pre-wrap">{startFailure.detail}</pre> : null}
        </div>
      ) : key !== null && sessions.status === 'pending' ? (
        <div className="flex flex-1 flex-col gap-2">
          <ScreenHeader>{RECONNECTING}</ScreenHeader>
          <div className="flex flex-col gap-2 p-4">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        </div>
      ) : (
        <EmptyPanel readyRepos={readyRepos} />
      )}
    </div>
  )
}

function EmptyPanel({ readyRepos }: { readonly readyRepos: readonly Extract<RepositoryEntry, { status: 'ready' }>[] }) {
  const [repoId, setRepoId] = useState<RepoId | null>(null)
  const only = readyRepos.length === 1 ? readyRepos[0] : undefined
  const chosen = readyRepos.find((repo) => repo.id === repoId) ?? only

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3">
      <EmptyState
        icon={MessageSquare}
        message={EMPTY_TITLE}
        className="py-0"
        action={readyRepos.length === 0 ? undefined : { label: 'New session', onClick: () => chosen !== undefined && startNewSession(chosen.id) }}
      />
      {readyRepos.length === 0 ? (
        <p title="Register a repository to start a session." className="text-small text-muted-foreground">
          Register a repository to start a session.
        </p>
      ) : readyRepos.length > 1 ? (
        <Select value={repoId ?? undefined} onValueChange={(value) => setRepoId(value as RepoId)}>
          <SelectTrigger className="w-64">
            <SelectValue placeholder="Pick a repository" />
          </SelectTrigger>
          <SelectContent>
            {readyRepos.map((repo) => (
              <SelectItem key={repo.id} value={repo.id}>
                {repo.config.repo}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  )
}

function StartingPanel({ repoLabel }: { readonly repoLabel: string }) {
  return (
    <div className="flex flex-1 flex-col gap-2">
      <ScreenHeader>Starting</ScreenHeader>
      <p className="px-4 text-small text-muted-foreground">{startingCopy(repoLabel)}</p>
    </div>
  )
}

function SessionLive({ snapshot, repoLabel }: { readonly snapshot: HostedSessionSnapshot; readonly repoLabel: string }) {
  const key = snapshot.sessionKey
  const draft = useDraft(key)
  const entries = useSessionEntries(key)
  const [sendError, setSendError] = useState<string | null>(null)
  const [closeConfirming, setCloseConfirming] = useState(false)
  const [interruptNoteText, setInterruptNoteText] = useState<string | null>(null)
  const [sessionGone, setSessionGone] = useState(false)

  async function handleSend(): Promise<void> {
    const text = draft.trim()
    if (text === '') return
    setDraft(key, '')
    setSendError(null)
    const outcome = await send(key, text)
    if (!outcome.ok) {
      setDraft(key, text)
      if (outcome.error === 'unknown-session') {
        setSessionGone(true)
        setSendError(SEND_FAILED_UNKNOWN_SESSION)
      } else {
        setSendError(SEND_FAILED_UNREACHABLE)
      }
    }
  }

  async function handleStop(): Promise<void> {
    const result = await stop(key)
    if (result === 'unreachable') return
    setInterruptNoteText(interruptNote(result))
  }

  function handleCloseClick(): void {
    if (snapshot.phase === 'streaming' || snapshot.phase === 'interrupting') setCloseConfirming(true)
    else void close(key)
  }

  const copy = composerCopy(snapshot.phase, sessionGone)
  const windowNoteVisible = entries.firstIndex > 0

  return (
    <>
      <SessionHeader snapshot={snapshot} repoLabel={repoLabel} onStop={() => void handleStop()} onClose={handleCloseClick} onDismiss={() => void dismiss(key)} />
      <AlertDialog open={closeConfirming} onOpenChange={(open) => !open && setCloseConfirming(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{CLOSE_CONFIRM_PROMPT}</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setCloseConfirming(false)}>
              {CLOSE_CONFIRM_NO}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setCloseConfirming(false)
                void close(key)
              }}
            >
              Close session
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {sendError !== null ? <ErrorBanner message={sendError} className="mx-auto w-full max-w-[680px]" /> : null}
      <div className="mx-auto flex w-full max-w-[680px] min-h-0 flex-1 flex-col gap-3">
        {windowNoteVisible ? <p className="text-meta text-muted-foreground">{windowNote()}</p> : null}
        <ConversationList entries={entries.entries} baseIndex={entries.firstIndex} live={entries.live} focusIndex={null} />
        {snapshot.phase === 'ended' && snapshot.end !== null ? <EndPanel end={snapshot.end} onNewSession={() => startNewSession(snapshot.repoId)} /> : null}
        <CommandStrip snapshot={snapshot} />
        <Composer
          value={draft}
          onChange={(value) => setDraft(key, value)}
          onSend={() => void handleSend()}
          onEscape={(event) => {
            if (snapshot.phase === 'streaming' || snapshot.phase === 'interrupting') {
              event.preventDefault()
              event.stopPropagation()
              void handleStop()
            }
          }}
          disabled={copy.disabled}
          placeholder={copy.placeholder}
          sendLabel={copy.sendLabel}
        />
        {interruptNoteText !== null ? <p className="text-meta text-muted-foreground">{interruptNoteText}</p> : null}
        <p className="text-meta text-muted-foreground">{COMPOSER_HINT}</p>
      </div>
    </>
  )
}

