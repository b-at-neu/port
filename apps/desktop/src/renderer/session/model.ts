// Pure page, composer and controls decisions for the Session screen — no DOM, no IPC.
import type { HostedSessionSnapshot, PendingPermission, SessionPhase } from '@/types/hosting'
import type { RepositoryEntry } from '@/utils/repos'
import type { PendingInteraction } from '@/utils/hosting/controls'
import { folderLabel } from '@/utils/workspace/label'
import {
  COMPOSER_PLAN_PLACEHOLDER,
  COMPOSER_QUESTION_PLACEHOLDER,
  CONTROLS_CLOSING_REASON,
  CONTROLS_ENDED_REASON,
  CONTROLS_STARTING_REASON,
  PHASE_COPY,
  PIPELINE_SEND_BLOCKED,
  SEND_FAILED_UNKNOWN_SESSION,
  SEND_FAILED_UNREACHABLE,
  sidebarDotLabel,
  STAGE_COMMAND_BLOCKED,
} from '@/renderer/session/copy'

export type SessionPageState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly snapshot: HostedSessionSnapshot }

interface SessionsQuery {
  readonly data: readonly HostedSessionSnapshot[] | undefined
  readonly status: 'pending' | 'error' | 'success'
}

/** A key that is in hand beats a later error, so a refetch failure never hides a session already on screen. */
export function sessionPageOf(key: string | null, sessions: SessionsQuery): SessionPageState {
  if (key === null) return { kind: 'empty' }
  const snapshot = sessions.data?.find((candidate) => candidate.sessionKey === key)
  if (snapshot !== undefined) return { kind: 'ready', snapshot }
  if (sessions.data === undefined && sessions.status === 'pending') return { kind: 'loading' }
  if (sessions.data === undefined && sessions.status === 'error') return { kind: 'error' }
  return { kind: 'empty' }
}

export function repoLabelFor(repos: readonly RepositoryEntry[] | undefined, snapshot: HostedSessionSnapshot): string {
  if (snapshot.repoId === null) return folderLabel(snapshot.workspace.folder)
  const entry = repos?.find((candidate) => candidate.id === snapshot.repoId)
  if (entry === undefined) return snapshot.repoId
  return 'config' in entry ? entry.config.repo : entry.displayName
}

export function isWorking(phase: SessionPhase): boolean {
  return phase === 'streaming' || phase === 'interrupting'
}

/** The oldest pending permission that carries a question or plan, or `null` when none does. */
export function oldestInteraction(pendingPermissions: readonly PendingPermission[]): (PendingPermission & { readonly interaction: PendingInteraction }) | null {
  let oldest: (PendingPermission & { readonly interaction: PendingInteraction }) | null = null
  for (const permission of pendingPermissions) {
    if (permission.interaction === null) continue
    if (oldest === null || permission.requestedAt.localeCompare(oldest.requestedAt) < 0) oldest = { ...permission, interaction: permission.interaction }
  }
  return oldest
}

/** What a session is waiting on, from its oldest pending question or plan, else a bare permission prompt; `null` when it waits on nothing. */
export function waitingLabelOf(session: Pick<HostedSessionSnapshot, 'pendingPermissions'>): string | null {
  const oldest = oldestInteraction(session.pendingPermissions)
  if (oldest !== null) return sidebarDotLabel(oldest.interaction.kind)
  return session.pendingPermissions.length > 0 ? 'Waiting for your permission' : null
}

interface ComposerState {
  readonly disabled: boolean
  readonly placeholder: string
  readonly sendLabel: string | null
}

/** `sessionGone` disables the composer whatever the phase says, since nothing tells the phase machine the session died. */
export function composerState(phase: SessionPhase, sessionGone: boolean, interaction: PendingInteraction | null): ComposerState {
  const copy = PHASE_COPY[phase]
  const disabled = copy.composerDisabled || sessionGone || interaction !== null
  if (interaction === null) return { disabled, placeholder: copy.composerPlaceholder, sendLabel: copy.sendLabel }
  return { disabled, placeholder: interaction.kind === 'question' ? COMPOSER_QUESTION_PLACEHOLDER : COMPOSER_PLAN_PLACEHOLDER, sendLabel: copy.sendLabel }
}

export function controlsDisabledReason(phase: SessionPhase): string | null {
  if (phase === 'starting') return CONTROLS_STARTING_REASON
  if (phase === 'closing') return CONTROLS_CLOSING_REASON
  if (phase === 'ended') return CONTROLS_ENDED_REASON
  return null
}

export function sendErrorOf(error: string | null, inStage: boolean): string {
  if (error === 'unknown-session') return SEND_FAILED_UNKNOWN_SESSION
  if (error === 'blocked-command') return inStage ? STAGE_COMMAND_BLOCKED : PIPELINE_SEND_BLOCKED
  return SEND_FAILED_UNREACHABLE
}

/** A hint starting with `<` names a required argument; prose or an empty hint never holds `Run` back. */
export function argumentRequired(hint: string): boolean {
  return hint.startsWith('<')
}
