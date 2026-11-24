// The Session screen — conversation, composer, and every UX state from the empty screen to ended.
import { useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { MessageSquare } from 'lucide-react'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { ScreenHeader } from '@/renderer/components/screen-header'
import { Screen, ScreenBody } from '@/renderer/components/screen'
import { ConversationList } from '@/renderer/components/conversation-list'
import { useIpcQuery } from '@/renderer/data/query'
import { useTranscript } from '@/renderer/data/transcript'
import type { SessionReady } from '@/renderer/data/transcript-model'
import { useActionMutation } from '@/renderer/actions/use-action-mutation'
import { ROUTE_IDS } from '@/renderer/router/routes'
import type { SessionSearch } from '@/types/router'
import { ChangesPane } from '@/renderer/session/changes-pane'
import type { RepositoryEntry } from '@/utils/repos'
import type { ComposerAttachment } from '@/utils/hosting/attachments'
import type { PlanDecision } from '@/utils/hosting/controls'
import type { HostedSessionSnapshot, SessionKey } from '@/types/hosting'
import { folderLabel } from '@/utils/workspace/label'
import { openNewSessionDialog } from '@/renderer/shell/stores'
import { setDraft, clearDraftAttachments } from '@/renderer/session/drafts'
import { useCloseSession, useDismissSession, useSendMessage } from '@/renderer/session/actions'
import { SessionHeader } from '@/renderer/session/header'
import { EndPanel } from '@/renderer/session/end-panel'
import { CommandStrip } from '@/renderer/session/command-strip'
import { RestoreBanner } from '@/renderer/session/restore-banner'
import { ArchiveDialog } from '@/renderer/session/archive-dialog'
import { ControlsBar } from '@/renderer/session/controls-bar'
import { QuestionCard } from '@/renderer/session/question-card'
import { PlanCard } from '@/renderer/session/plan-card'
import { nextMode } from '@/renderer/session/controls-model'
import { QUESTION_SKIPPED_MESSAGE, COMPOSER_PLAN_PLACEHOLDER, COMPOSER_QUESTION_PLACEHOLDER, modeToast } from '@/renderer/session/interaction-copy'
import { toast } from 'sonner'
import { PromptInput } from '@/renderer/session/prompt-input'
import { PIPELINE_SEND_BLOCKED, STAGE_COMMAND_BLOCKED } from '@/renderer/session/composer-copy'
import { COMPOSER_HINT, composerCopy, EMPTY_TITLE, interruptNote, originDividerLabel, RECONNECTING, SEND_FAILED_UNKNOWN_SESSION, SEND_FAILED_UNREACHABLE, windowNote } from '@/renderer/session/copy'
import { BackgroundTasksPanel } from '@/renderer/session/background-tasks'

const EMPTY_TRANSCRIPT: Pick<SessionReady, 'entries' | 'firstIndex' | 'live' | 'history'> = { entries: [], firstIndex: 0, live: null, history: { kind: 'none' } }

function repoLabelFor(repos: readonly RepositoryEntry[] | undefined, snapshot: HostedSessionSnapshot): string {
  if (snapshot.repoId === null) return folderLabel(snapshot.workspace.folder)
  const entry = repos?.find((candidate) => candidate.id === snapshot.repoId)
  if (entry === undefined) return snapshot.repoId
  return 'config' in entry ? entry.config.repo : entry.displayName
}

export function SessionScreen() {
  const search = useSearch({ from: ROUTE_IDS.session })
  const sessions = useIpcQuery('session.list')
  const repos = useIpcQuery('repos.list')
  const key = (search.key ?? null) as SessionKey | null

  const snapshot = key !== null ? (sessions.data ?? []).find((candidate) => candidate.sessionKey === key) ?? null : null

  if (snapshot !== null) {
    return (
      <SessionLive
        key={snapshot.sessionKey}
        snapshot={snapshot}
        repoLabel={repoLabelFor(repos.data?.ok === true ? repos.data.repositories : undefined, snapshot)}
        paneOpen={search.pane === 'changes'}
      />
    )
  }

  if (key !== null && sessions.status === 'pending') {
    return (
      <Screen header={<ScreenHeader>{RECONNECTING}</ScreenHeader>}>
        <ScreenBody variant="list">
          <div className="flex flex-col gap-2 p-4">
            <RestoreBanner />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        </ScreenBody>
      </Screen>
    )
  }

  return <EmptyPanel />
}

function EmptyPanel() {
  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <RestoreBanner />
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <EmptyState icon={MessageSquare} message={EMPTY_TITLE} className="py-0" data-slot="session-empty" action={{ label: 'New session', onClick: () => openNewSessionDialog() }} />
      </div>
    </div>
  )
}

function SessionLive({ snapshot, repoLabel, paneOpen }: { readonly snapshot: HostedSessionSnapshot; readonly repoLabel: string; readonly paneOpen: boolean }) {
  const key = snapshot.sessionKey
  const navigate = useNavigate()
  const transcript = useTranscript({ kind: 'session', sessionKey: key }).view
  const entries = transcript.status === 'ready' ? transcript : EMPTY_TRANSCRIPT
  const { send } = useSendMessage()
  const interrupt = useActionMutation('session.interrupt')
  const { close, confirmDialog: closeDialog } = useCloseSession()
  const { dismiss } = useDismissSession()
  const questionAnswer = useActionMutation('session.questionAnswer')
  const planAnswer = useActionMutation('session.planAnswer')
  const permissionAnswer = useActionMutation('session.permissionAnswer')
  const controlsSet = useActionMutation('session.controlsSet')
  const [sendError, setSendError] = useState<string | null>(null)
  const [archiving, setArchiving] = useState(false)
  const [interruptNoteText, setInterruptNoteText] = useState<string | null>(null)
  const [sessionGone, setSessionGone] = useState(false)

  async function handleSend(text: string, attachments: readonly ComposerAttachment[]): Promise<void> {
    const trimmed = text.trim()
    if (trimmed === '' && attachments.length === 0) return
    setDraft(key, '')
    clearDraftAttachments(key)
    setSendError(null)
    const outcome = await send(key, trimmed, attachments)
    if (!outcome.ok) {
      setDraft(key, trimmed)
      if (outcome.error === 'unknown-session') {
        setSessionGone(true)
        setSendError(SEND_FAILED_UNKNOWN_SESSION)
      } else if (outcome.error === 'blocked-command') {
        setSendError(snapshot.stage !== null ? STAGE_COMMAND_BLOCKED : PIPELINE_SEND_BLOCKED)
      } else {
        setSendError(SEND_FAILED_UNREACHABLE)
      }
    }
  }

  async function handleStop(): Promise<void> {
    const result = await interrupt.perform({ sessionKey: key })
    if (result === 'unreachable') return
    setInterruptNoteText(interruptNote(result.ok ? result.queuedAfterInterrupt : null))
  }

  function handleCloseClick(): void {
    void close(key, { confirm: snapshot.phase === 'streaming' || snapshot.phase === 'interrupting' })
  }

  function toggleChanges(): void {
    void navigate({ to: ROUTE_IDS.session, search: (prev: SessionSearch) => ({ ...prev, pane: prev.pane === 'changes' ? null : ('changes' as const) }) })
  }

  function closeChanges(): void {
    void navigate({ to: ROUTE_IDS.session, search: (prev: SessionSearch) => ({ ...prev, pane: null }) })
  }

  function handleDismiss(): void {
    if (snapshot.workspace.worktree !== null) {
      setArchiving(true)
      return
    }
    void dismiss(key, 'keep')
  }

  const copy = composerCopy(snapshot.phase, sessionGone)
  const windowNoteVisible = entries.firstIndex > 0

  const interactionEntry = snapshot.pendingPermissions.filter((permission) => permission.interaction !== null).sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))[0] ?? null
  const interaction = interactionEntry?.interaction ?? null
  const [questionError, setQuestionError] = useState<string | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)

  async function handleQuestionSend(answers: Record<string, string>): Promise<void> {
    if (interactionEntry === null) return
    setQuestionError(null)
    const result = await questionAnswer.perform({ sessionKey: key, permissionId: interactionEntry.permissionId, answers })
    if (result !== 'unreachable' && !result.ok) setQuestionError(result.kind)
  }

  async function handleQuestionSkip(): Promise<void> {
    if (interactionEntry === null) return
    await permissionAnswer.perform({ sessionKey: key, permissionId: interactionEntry.permissionId, decision: 'deny', message: QUESTION_SKIPPED_MESSAGE })
  }

  async function answerPlan(decision: PlanDecision): Promise<void> {
    if (interactionEntry === null) return
    setPlanError(null)
    const result = await planAnswer.perform({ sessionKey: key, permissionId: interactionEntry.permissionId, decision })
    if (result !== 'unreachable' && !result.ok) setPlanError(result.kind)
  }

  async function handleShiftTab(): Promise<void> {
    const mode = nextMode(snapshot.controls.permissionMode)
    const result = await controlsSet.perform({ sessionKey: key, permissionMode: mode })
    if (result !== 'unreachable' && result.ok) toast(modeToast(mode === 'default' ? 'Ask before edits' : mode === 'acceptEdits' ? 'Accept edits' : 'Plan mode'))
  }

  const composerDisabled = copy.disabled || interaction !== null
  const composerPlaceholder = interaction === null ? copy.placeholder : interaction.kind === 'question' ? COMPOSER_QUESTION_PLACEHOLDER : COMPOSER_PLAN_PLACEHOLDER

  return (
    <Screen
      header={
        <SessionHeader
          snapshot={snapshot}
          repoLabel={repoLabel}
          changesOpen={paneOpen}
          onToggleChanges={toggleChanges}
          onStop={() => void handleStop()}
          onClose={handleCloseClick}
          onDismiss={handleDismiss}
        />
      }
    >
      <ArchiveDialog snapshot={snapshot} open={archiving} onOpenChange={setArchiving} />
      {closeDialog}
      <div className="flex min-h-0 flex-1 overflow-hidden">
      <ScreenBody variant="conversation" className="flex-1">
        <RestoreBanner />
        {sendError !== null ? <ErrorBanner message={sendError} /> : null}
        {windowNoteVisible ? <p className="text-meta text-muted-foreground">{windowNote()}</p> : null}
        <ConversationList
          entries={entries.entries}
          baseIndex={entries.firstIndex}
          live={entries.live}
          focusIndex={null}
          history={entries.history}
          historyDividerLabel={originDividerLabel(snapshot.origin)}
        />
        {snapshot.phase === 'ended' && snapshot.end !== null ? (
          <EndPanel end={snapshot.end} onNewSession={() => openNewSessionDialog({ kind: 'path', path: snapshot.workspace.root ?? snapshot.workspace.folder })} />
        ) : null}
        {snapshot.repoId !== null && snapshot.stage === null ? <CommandStrip snapshot={snapshot} /> : null}
        <BackgroundTasksPanel sessionKey={key} tasks={snapshot.backgroundTasks} />
        {interaction !== null && interaction.kind === 'question' ? (
          <QuestionCard questions={interaction.questions} sending={questionAnswer.pending} error={questionError} onSend={(answers) => void handleQuestionSend(answers)} onSkip={() => void handleQuestionSkip()} />
        ) : null}
        {interaction !== null && interaction.kind === 'plan' ? (
          <PlanCard plan={interaction.plan} sending={planAnswer.pending} error={planError} onApprove={(mode) => void answerPlan({ kind: 'approve', mode })} onKeepPlanning={(feedback) => void answerPlan({ kind: 'keep-planning', feedback })} />
        ) : null}
        <PromptInput
          sessionKey={key}
          repoId={snapshot.repoId}
          snapshot={snapshot}
          onSend={(text, attachments) => void handleSend(text, attachments)}
          onEscape={(event) => {
            if (snapshot.phase === 'streaming' || snapshot.phase === 'interrupting') {
              event.preventDefault()
              event.stopPropagation()
              void handleStop()
            }
          }}
          onShiftTab={() => void handleShiftTab()}
          disabled={composerDisabled}
          placeholder={composerPlaceholder}
          sendLabel={copy.sendLabel}
        />
        <ControlsBar
          sessionKey={key}
          controls={snapshot.controls}
          models={snapshot.models}
          usage={snapshot.usage}
          disabled={snapshot.phase === 'starting' || snapshot.phase === 'closing' || snapshot.phase === 'ended'}
          disabledReason={snapshot.phase === 'starting' ? 'Waiting for the session to start.' : snapshot.phase === 'closing' ? 'This session is closing.' : snapshot.phase === 'ended' ? 'This session has ended.' : null}
        />
        {interruptNoteText !== null ? <p className="text-meta text-muted-foreground">{interruptNoteText}</p> : null}
        <p className="text-meta text-muted-foreground">{COMPOSER_HINT}</p>
      </ScreenBody>
      {paneOpen && snapshot.workspace.root !== null ? <ChangesPane snapshot={snapshot} onClose={closeChanges} /> : null}
      </div>
    </Screen>
  )
}
