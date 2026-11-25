import { useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { EmptyState } from '@/renderer/components/empty-state'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { ScreenHeader } from '@/renderer/components/screen-header'
import { Page } from '@/renderer/components/page'
import { ConversationList } from '@/renderer/components/conversation-list'
import { useIpcQuery } from '@/renderer/data/query'
import { useTranscript } from '@/renderer/data/transcript'
import type { SessionReady } from '@/renderer/data/transcript-model'
import { useActionMutation } from '@/renderer/actions/use-action-mutation'
import { ROUTE_IDS } from '@/renderer/app/routes'
import type { SessionSearch } from '@/types/router'
import { ChangesPane } from '@/renderer/session/changes-pane'
import type { ComposerAttachment } from '@/utils/hosting/attachments'
import type { PlanDecision } from '@/utils/hosting/controls'
import type { HostedSessionSnapshot, SessionKey } from '@/types/hosting'
import { openNewSessionDialog } from '@/renderer/app/stores'
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
import { modeLabel, nextMode } from '@/renderer/session/controls-model'
import { composerState, controlsDisabledReason, isWorking, oldestInteraction, repoLabelFor, sendErrorOf, sessionPageOf } from '@/renderer/session/model'
import { PromptInput } from '@/renderer/session/prompt-input'
import { BackgroundTasksPanel } from '@/renderer/session/background-tasks'
import { COMPOSER_HINT, EMPTY_TITLE, interruptNote, modeToast, NEW_SESSION_BUTTON, originDividerLabel, QUESTION_SKIPPED_MESSAGE, RECONNECTING, SESSIONS_UNREACHABLE, WINDOW_NOTE } from '@/renderer/session/copy'

const EMPTY_TRANSCRIPT: Pick<SessionReady, 'entries' | 'firstIndex' | 'live' | 'history'> = { entries: [], firstIndex: 0, live: null, history: { kind: 'none' } }

export function SessionScreen() {
  const search = useSearch({ from: ROUTE_IDS.session })
  const sessions = useIpcQuery('session.list')
  const repos = useIpcQuery('repos.list')
  const key = (search.key ?? null) as SessionKey | null
  const page = sessionPageOf(key, sessions)

  if (page.kind === 'ready') {
    return (
      <SessionLive
        key={page.snapshot.sessionKey}
        snapshot={page.snapshot}
        repoLabel={repoLabelFor(repos.data?.ok === true ? repos.data.repositories : undefined, page.snapshot)}
        paneOpen={search.pane === 'changes'}
      />
    )
  }

  return (
    <Page
      variant="conversation"
      header={page.kind === 'loading' ? <ScreenHeader>{RECONNECTING}</ScreenHeader> : null}
      lead={<RestoreBanner />}
      state={page.kind}
      loading={
        <>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </>
      }
      errorMessage={SESSIONS_UNREACHABLE}
      onRetry={() => void sessions.refetch()}
      empty={
        <div className="flex flex-1 flex-col items-center justify-center">
          <EmptyState icon={MessageSquare} message={EMPTY_TITLE} className="py-0" data-slot="session-empty" action={{ label: NEW_SESSION_BUTTON, onClick: () => openNewSessionDialog() }} />
        </div>
      }
    >
      {null}
    </Page>
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
  const [questionError, setQuestionError] = useState<string | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)

  const interactionEntry = oldestInteraction(snapshot.pendingPermissions)
  const interaction = interactionEntry?.interaction ?? null
  const composer = composerState(snapshot.phase, sessionGone, interaction)
  const controlsReason = controlsDisabledReason(snapshot.phase)

  async function handleSend(text: string, attachments: readonly ComposerAttachment[]): Promise<void> {
    const trimmed = text.trim()
    if (trimmed === '' && attachments.length === 0) return
    setDraft(key, '')
    clearDraftAttachments(key)
    setSendError(null)
    const outcome = await send(key, trimmed, attachments)
    if (!outcome.ok) {
      setDraft(key, trimmed)
      if (outcome.error === 'unknown-session') setSessionGone(true)
      setSendError(sendErrorOf(outcome.error, snapshot.stage !== null))
    }
  }

  async function handleStop(): Promise<void> {
    const result = await interrupt.perform({ sessionKey: key })
    if (result === 'unreachable') return
    setInterruptNoteText(interruptNote(result.ok ? result.queuedAfterInterrupt : null))
  }

  function handleCloseClick(): void {
    void close(key, { confirm: isWorking(snapshot.phase) })
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
    if (result !== 'unreachable' && result.ok) toast(modeToast(modeLabel(mode)))
  }

  return (
    <Page
      variant="conversation"
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
      lead={<RestoreBanner />}
      aside={paneOpen && snapshot.workspace.root !== null ? <ChangesPane snapshot={snapshot} onClose={closeChanges} /> : undefined}
    >
      <ArchiveDialog snapshot={snapshot} open={archiving} onOpenChange={setArchiving} />
      {closeDialog}
      {sendError !== null ? <ErrorBanner message={sendError} /> : null}
      {entries.firstIndex > 0 ? <p className="text-meta text-muted-foreground">{WINDOW_NOTE}</p> : null}
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
          if (isWorking(snapshot.phase)) {
            event.preventDefault()
            event.stopPropagation()
            void handleStop()
          }
        }}
        onShiftTab={() => void handleShiftTab()}
        disabled={composer.disabled}
        placeholder={composer.placeholder}
        sendLabel={composer.sendLabel}
      />
      <ControlsBar
        sessionKey={key}
        controls={snapshot.controls}
        models={snapshot.models}
        usage={snapshot.usage}
        disabled={controlsReason !== null}
        disabledReason={controlsReason}
      />
      {interruptNoteText !== null ? <p className="text-meta text-muted-foreground">{interruptNoteText}</p> : null}
      <p className="text-meta text-muted-foreground">{COMPOSER_HINT}</p>
    </Page>
  )
}
