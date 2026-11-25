// Every string the Session page and its components render.
import type { HostedSessionSnapshot, SessionCapabilities, SessionEnd, SessionEndReason, SessionInvokeResult, SessionPhase, SessionRateLimit } from '@/types/hosting'
import type { RenderableStartFailure, StartFailureCopy, UsageNotice } from '@/types/session'
import type { SessionChangesFailureKind } from '@/types/workspace'
import { RUNTIME_COPY } from '@/renderer/runtime/copy'
import { formatClock } from '@/renderer/lib/time'
import { MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_PDF_BYTES, MAX_TEXT_BYTES, MAX_TOTAL_BYTES } from '@/utils/hosting/attachments'
import { contextPercent, formatCost, formatTokens, type SessionUsage, type UsageTotals } from '@/utils/hosting/usage'

type StopState = 'enabled' | 'disabled' | 'stopping' | 'hidden'
type CloseState = 'enabled' | 'confirm' | 'closing' | 'hidden'

interface PhaseCopy {
  readonly stop: StopState
  readonly close: CloseState
  readonly composerDisabled: boolean
  readonly composerPlaceholder: string
  readonly sendLabel: string | null
}

const WORKING_PLACEHOLDER = 'Claude is working — this message runs next.'

export const PHASE_COPY: Readonly<Record<SessionPhase, PhaseCopy>> = {
  starting: { stop: 'disabled', close: 'enabled', composerDisabled: false, composerPlaceholder: 'Message Claude…', sendLabel: 'Send' },
  ready: { stop: 'disabled', close: 'enabled', composerDisabled: false, composerPlaceholder: 'Message Claude…', sendLabel: 'Send' },
  streaming: { stop: 'enabled', close: 'confirm', composerDisabled: false, composerPlaceholder: WORKING_PLACEHOLDER, sendLabel: 'Queue' },
  interrupting: { stop: 'stopping', close: 'confirm', composerDisabled: false, composerPlaceholder: WORKING_PLACEHOLDER, sendLabel: 'Queue' },
  closing: { stop: 'disabled', close: 'closing', composerDisabled: true, composerPlaceholder: '', sendLabel: null },
  ended: { stop: 'hidden', close: 'hidden', composerDisabled: true, composerPlaceholder: 'This session has ended.', sendLabel: null },
}

export const PHASE_LABEL: Readonly<Record<Exclude<SessionPhase, 'ended'>, string>> = {
  starting: 'Starting',
  ready: 'Idle',
  streaming: 'Streaming',
  interrupting: 'Stopping…',
  closing: 'Closing…',
}

interface EndCopy {
  readonly title: string
  readonly body: string
}

export const END_COPY: Readonly<Record<SessionEndReason, EndCopy>> = {
  completed: { title: 'Ended', body: 'Claude Code ended the session.' },
  closed: { title: 'Closed', body: 'You closed this session. Its transcript is under Repositories → Transcripts.' },
  'exit-nonzero': { title: 'Crashed', body: 'Claude Code exited with code {exitCode}.' },
  signal: { title: 'Crashed', body: 'Claude Code was stopped by signal {signal}.' },
  'process-error': { title: 'Crashed', body: 'Claude Code failed to run.' },
  'stream-error': { title: 'Ended unexpectedly', body: "The session ended with an error Port doesn't recognise." },
  'resume-rejected': { title: 'Resume refused', body: 'Claude Code refused to resume at that point.' },
}

export function endBody(end: SessionEnd): string {
  const template = END_COPY[end.reason].body
  return template.replace('{exitCode}', String(end.exitCode)).replace('{signal}', String(end.signal))
}

export function startFailureCopy(result: RenderableStartFailure): StartFailureCopy {
  if (result.kind === 'at-capacity') {
    return { title: 'Port is busy', body: `Port is already hosting ${String(result.limit)} sessions — the limit. Close one or raise the limit in the session list.`, detail: null }
  }
  if (result.kind === 'folder-busy') {
    return { title: 'Folder in use', body: 'Another session is already working in this folder. Start it in a new worktree.', detail: null }
  }
  if (result.kind === 'folder-missing') {
    return result.path !== null
      ? { title: 'Folder missing', body: 'That folder no longer exists. Choose another.', detail: result.path }
      : { title: 'Folder missing', body: "Port couldn't find this session's folder.", detail: null }
  }
  if (result.kind === 'not-git') {
    return { title: 'Not a git repository', body: "This folder isn't a git repository.", detail: null }
  }
  if (result.kind === 'worktree-failed') {
    return { title: "Couldn't create the worktree", body: `Couldn't create the worktree: ${result.message}.`, detail: null }
  }
  const copy = RUNTIME_COPY[result.diagnosis]
  return { title: copy.title, body: copy.body, detail: result.detail }
}

export function interruptNote(queuedAfterInterrupt: number | null): string | null {
  if (queuedAfterInterrupt === null) return "Stopped. Port couldn't confirm whether queued messages were cancelled."
  if (queuedAfterInterrupt === 0) return null
  return `Stopped. ${String(queuedAfterInterrupt)} queued message${queuedAfterInterrupt === 1 ? '' : 's'} will still run.`
}

export const EMPTY_TITLE = 'No session open.'
export const RECONNECTING = 'Reconnecting to your session…'
export const SESSIONS_UNREACHABLE = "Couldn't load your sessions from the main process."
export const SEND_FAILED_UNKNOWN_SESSION = 'Port no longer has this session. It may have ended when the app restarted.'
export const SEND_FAILED_UNREACHABLE = "Couldn't reach the main process. Your message wasn't sent."
export const START_UNREACHABLE = "Couldn't reach the main process."
export const WINDOW_NOTE = "Earlier messages aren't shown here. The full conversation is in this session's transcript under Repositories → Transcripts."
export const COMPOSER_HINT = 'Enter to send · Shift+Enter for a new line'
export const CONTROLS_STARTING_REASON = 'Waiting for the session to start.'
export const CONTROLS_CLOSING_REASON = 'This session is closing.'
export const CONTROLS_ENDED_REASON = 'This session has ended.'

export const NEW_SESSION_BUTTON = 'New session'
export const STOP_BUTTON = 'Stop'
export const STOPPING_BUTTON = 'Stopping…'
export const CLOSE_BUTTON = 'Close session'
export const CLOSING_BUTTON = 'Closing…'
export const DETACHED_BRANCH = 'detached'
export const CHANGES_BUTTON = 'Changes'

export function originDividerLabel(origin: HostedSessionSnapshot['origin']): string {
  return origin.kind === 'forked' ? 'Forked here' : 'Resumed here'
}

export const LOADING_COMMANDS = 'Loading commands…'
export const COMMANDS_UNAVAILABLE = 'Commands unavailable in this session'
export const NO_MATCHING_COMMANDS = 'No matching commands'

export const LOADING_FILES = 'Loading files…'
export const FILES_UNREADABLE = "Couldn't list files in this session's folder."
export const NO_MATCHING_FILES = 'No matching files'

export function filesTruncatedNote(limit: number): string {
  return `Showing the first ${limit.toLocaleString('en-US')} files`
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
}

function kilobytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KB`
}

export function unsupportedFileNotice(name: string): string {
  return `${name} isn't supported. Attach an image (PNG, JPEG, GIF, WebP), a PDF, or a text file.`
}

export function oversizedImageNotice(name: string): string {
  return `${name} is over ${megabytes(MAX_IMAGE_BYTES)}.`
}

export function oversizedPdfNotice(name: string): string {
  return `${name} is over ${megabytes(MAX_PDF_BYTES)}.`
}

export function oversizedTextNotice(name: string): string {
  return `${name} is over ${kilobytes(MAX_TEXT_BYTES)}.`
}

export function unreadableFileNotice(name: string): string {
  return `Couldn't read ${name}.`
}

export const TOO_MANY_ATTACHMENTS_NOTICE = `Only ${String(MAX_ATTACHMENTS)} attachments fit in one message.`
export const TOTAL_TOO_LARGE_NOTICE = `Attachments are over ${megabytes(MAX_TOTAL_BYTES)} in total.`

export const ATTACH_FILES_TOOLTIP = 'Attach files'
export const DROP_TO_ATTACH_HINT = 'Drop to attach'

export function removeAttachmentLabel(name: string): string {
  return `Remove ${name}`
}

export const AGENTS_DISCLOSURE_NOTE = 'Stage agents are started by the pipeline, never from here.'
export const PIPELINE_SEND_BLOCKED = '/port:pipeline runs in a terminal session, not in port. Start it with `claude` in the repository.'
export const STAGE_COMMAND_BLOCKED = "port commands don't run inside a stage session. Start them from a new session."

export const QUESTION_HEADING = 'Claude is asking'
export const QUESTION_SEND = 'Send answers'
export const QUESTION_SKIP = 'Skip question'
export const QUESTION_SKIPPED_MESSAGE = 'The operator skipped this question.'
export const QUESTION_OTHER_LABEL = 'Other'

export function questionProgress(total: number): string {
  return total <= 1 ? QUESTION_HEADING : `${QUESTION_HEADING} — 1 of ${String(total)}`
}

export function questionAnswerFailed(kind: string): string {
  return `Couldn't send your answers: ${kind}.`
}

export const PLAN_HEADING = "Claude's plan"
export const PLAN_EMPTY = "Claude didn't include a plan text."
export const PLAN_FEEDBACK_PLACEHOLDER = 'What should Claude change?'
export const PLAN_APPROVE_ACCEPT_EDITS = 'Approve and accept edits'
export const PLAN_APPROVE_ASK = 'Approve, ask before edits'
export const PLAN_KEEP_PLANNING = 'Keep planning'
export const PLAN_SENDING = 'Sending…'

export function planAnswerFailed(kind: string): string {
  return `Couldn't send your decision: ${kind}.`
}

export const COMPOSER_QUESTION_PLACEHOLDER = "Answer Claude's question above."
export const COMPOSER_PLAN_PLACEHOLDER = 'Review the plan above.'

export function modelLoadFailed(message: string): string {
  return `Couldn't read the model list: ${message}`
}

export function controlsChangeFailed(reason: string): string {
  return `Couldn't change the model: ${reason}.`
}

export function modeToast(label: string): string {
  return `Mode: ${label}`
}

export const MODELS_LOADING = 'Loading models…'

export function sidebarDotLabel(interactionKind: 'question' | 'plan'): string {
  return interactionKind === 'question' ? 'Claude is asking a question' : 'Plan ready for review'
}

function joinWithAnd(items: readonly string[]): string {
  if (items.length <= 2) return items.join(' and ')
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

export function chipCopy(capabilities: SessionCapabilities): string {
  if (capabilities.kind === 'pending') return '◌ Pipeline · loading commands…'
  if (capabilities.kind === 'unavailable') return '⚠ Pipeline commands unavailable'

  const { plugin } = capabilities

  switch (plugin.kind) {
    case 'unconfirmed':
      return '◌ port · confirmed on the first turn'
    case 'missing':
      return "⚠ port didn't load"
    case 'duplicate':
      return '⚠ Two port plugins loaded'
    case 'loaded':
      return plugin.version === null ? '✓ port' : `✓ port ${plugin.version}`
  }
}

interface CapabilitiesBanner {
  readonly text: string
  readonly detail: string | null
}

export function bannerCopy(capabilities: SessionCapabilities): CapabilitiesBanner | null {
  if (capabilities.kind === 'pending') return null
  if (capabilities.kind === 'unavailable') return { text: "Claude Code didn't return this session's commands.", detail: capabilities.message }

  const { plugin } = capabilities

  if (plugin.kind === 'missing') {
    return { text: "This session has no port plugin. The repository's `.claude/settings.json` enables `port@port` — check the install with `/plugin` in a terminal session.", detail: null }
  }

  if (plugin.kind === 'duplicate') {
    return { text: `Claude Code loaded port from ${joinWithAnd(plugin.paths)}. A command may resolve to either copy.`, detail: null }
  }

  return null
}

export const INVOKE_REJECTED = "Couldn't reach the main process. The command wasn't sent."

export function invokeFailureCopy(name: string, result: Extract<SessionInvokeResult, { readonly ok: false }>): string {
  switch (result.kind) {
    case 'invalid-command':
      return `Port didn't send /${name}: ${result.reason}.`
    case 'unknown-command':
      return `/${result.name} isn't available in this session any more.`
    case 'unknown-session':
      return SEND_FAILED_UNKNOWN_SESSION
  }
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

interface ChangesHeader {
  readonly prefix: string
  readonly branch: string | null
  readonly sha: string
}

export function changesHeader(base: { readonly sha: string }, worktreeBranch: string | null): ChangesHeader {
  return { prefix: 'Changes since', branch: worktreeBranch, sha: shortSha(base.sha) }
}

export function changesEmpty(sha: string): string {
  return `No changes since ${shortSha(sha)}.`
}

export function changesTooLarge(count: number): string {
  return `This diff is too large to show here. ${String(count)} file${count === 1 ? '' : 's'} changed.`
}

export function untrackedLine(path: string): string {
  return `New, not yet added: ${path}`
}

export function binaryLine(path: string): string {
  return `${path} · binary`
}

interface NumstatLine {
  readonly added: string
  readonly removed: string
}

export function numstatLine({ additions, deletions }: { readonly additions: number; readonly deletions: number }): NumstatLine {
  return { added: `+${String(additions)}`, removed: `−${String(deletions)}` }
}

export const REFRESH_CHANGES = 'Refresh changes'
export const CLOSE_CHANGES = 'Close changes'

export function changesErrorCopy(failure: { readonly kind: SessionChangesFailureKind; readonly message: string } | 'unreachable', baseSha: string | null): string {
  if (failure === 'unreachable') return 'Could not reach the main process.'
  switch (failure.kind) {
    case 'base-missing':
      return baseSha !== null ? `The base commit ${shortSha(baseSha)} is gone from this repository.` : 'The base commit is gone from this repository.'
    case 'folder-missing':
      return "This session's folder no longer exists."
    case 'git-failed':
      return `git couldn't compute the diff: ${failure.message}`
    case 'unknown-session':
      return 'This session is no longer open.'
    case 'not-git':
      return "This session's folder isn't a git repository."
  }
}

export const LIMIT_STEPPER_TITLE = "Each session is its own Claude Code process. They all share your subscription's usage limit."
export const CAPACITY_SET_FAILED = "Couldn't reach the main process. The limit wasn't changed."

export const DISMISS_BUTTON = 'Dismiss'

const WINDOW_NAMES: Readonly<Record<'five-hour' | 'weekly' | 'weekly-opus' | 'weekly-sonnet' | 'overage' | 'unknown', string>> = {
  'five-hour': '5-hour',
  weekly: 'weekly',
  'weekly-opus': 'weekly Opus',
  'weekly-sonnet': 'weekly Sonnet',
  overage: 'extra usage',
  unknown: 'usage',
}

function windowName(window: SessionRateLimit['window']): string {
  return WINDOW_NAMES[window ?? 'unknown']
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

function resetsSuffix(resetsAt: string | null, now: Date): string {
  return resetsAt === null ? '' : ` · resets ${formatClock(resetsAt, now)}`
}

interface UsageNoticeLines {
  readonly main: string
  readonly sub: string
}

export function usageNoticeLines(notice: UsageNotice, now: Date): UsageNoticeLines {
  const window = windowName(notice.window)
  const resets = resetsSuffix(notice.resetsAt, now)
  if (notice.status === 'warning') {
    return { main: `⚠ Nearing your ${window} usage limit${resets}`, sub: 'Every open session draws on the same limit.' }
  }
  return { main: `⛔ ${capitalize(window)} usage limit reached${resets}`, sub: 'New turns in every session will fail until then.' }
}

export function restoreBannerLine(count: number): string {
  const verb = count === 1 ? 'was' : 'were'
  return `${String(count)} session${count === 1 ? '' : 's'} ${verb} open when Port last closed.`
}

export const RESTORE_RESUME_ALL = 'Resume all'
export const RESTORE_REVIEW = 'Review'
export const RESTORE_FORGET = 'Forget'
export const RESTORE_RESUME_ONE = 'Resume'

export function restoreUnavailableLine(reason: string): string {
  return `This repository isn't ready — ${reason}`
}

export function restoreOpenedLine(startedAt: string, now: Date): string {
  return `opened ${formatClock(startedAt, now)}`
}

export function restorePartialLine(resumed: number, total: number, limit: number): string {
  return `Resumed ${String(resumed)} of ${String(total)} — the limit is ${String(limit)}. Raise it or close a session to resume the rest.`
}

export const USAGE_HEADING = 'Usage'
export const USAGE_THIS_SESSION = 'This session'
export const USAGE_ALL_SESSIONS = 'All sessions'
export const USAGE_NONE = 'No usage reported yet.'
export const CONTEXT_UNKNOWN = 'No context reading yet.'
export const CONTEXT_METER_LABEL = 'Context'

export function usageValue(totals: UsageTotals): string {
  return `${formatCost(totals.costUsd)} · ${formatTokens(totals.totalTokens)} tokens`
}

export function usageSessionsLine(count: number): string {
  return `${String(count)} session${count === 1 ? '' : 's'} with a reading`
}

export function contextMeterLabel(usage: SessionUsage | null): string {
  if (usage === null || contextPercent(usage) === null) return CONTEXT_UNKNOWN
  return `${formatTokens(usage.contextTokens)} of ${formatTokens(usage.contextWindow)} tokens in context`
}

type MarkKind = 'pinned' | 'archived'

export function menuItemLabel(kind: MarkKind, on: boolean): string {
  if (kind === 'pinned') return on ? 'Unpin' : 'Pin'
  return on ? 'Unarchive' : 'Archive'
}

export const MENU_DISABLED_HINT = 'Available once the session has started'

export function markPendingToast(kind: MarkKind): string {
  return kind === 'pinned' ? 'Updating the pin…' : 'Updating the archive…'
}

export function markSuccessToast(kind: MarkKind, on: boolean): string {
  if (kind === 'pinned') return on ? 'Pinned.' : 'Unpinned.'
  return on ? "Archived. It's hidden from History." : 'Unarchived.'
}

export const ARCHIVE_CONFIRM_PROMPT = 'Archive while Claude is working? The current turn is abandoned.'
export const ARCHIVE_CONFIRM_ACTION = 'Archive session'

export function markFailureToast(kind: MarkKind): string {
  return `Couldn't ${kind === 'pinned' ? 'pin' : 'archive'} the session: its id isn't valid.`
}

export const SESSION_ACTIONS_LABEL = 'Session actions'
export const RENAME_LABEL = 'Rename'

export const CLOSE_CONFIRM_PROMPT = 'Close while Claude is working? The current turn is abandoned.'
export const CLOSE_CONFIRM_NO = 'Keep working'

export const NEW_SESSION_DIALOG_TITLE = 'New session'
export const NEW_SESSION_EMPTY_LINE = 'Pick a folder to start a session in.'
export const NEW_SESSION_CHOOSE_FOLDER = 'Choose folder…'
export const NEW_SESSION_FOLDERS_FAILED = "Couldn't load your folders."
export const NEW_SESSION_WORKTREE_LABEL = 'Create a new worktree'
export const NEW_SESSION_CANCEL = 'Cancel'
export const NEW_SESSION_START = 'Start session'
export const NEW_SESSION_STARTING = 'Starting…'

export const ARCHIVE_DIALOG_TITLE = "Remove this session's worktree?"
export const ARCHIVE_DIRTY_BODY = 'The worktree has uncommitted or untracked changes. Removing it deletes them.'
export const ARCHIVE_KEEP = 'Keep worktree'
export const ARCHIVE_REMOVE = 'Remove worktree'
export const ARCHIVE_REMOVE_ANYWAY = 'Remove anyway'

export function archiveBody(path: string, branch: string | null): string {
  if (branch === null) return `${path}, a detached checkout. No branch is kept.`
  return `${path} on branch ${branch}. The branch is kept.`
}

export function archiveRemoveFailedToast(message: string): string {
  return `Couldn't remove the worktree: ${message}`
}

export const ARCHIVE_UNAVAILABLE = "That session can't be dismissed right now."
export const ARCHIVE_PENDING = 'Dismissing the session…'

export function archiveSuccessToast(choice: 'keep' | 'remove' | 'force'): string {
  return choice === 'keep' ? 'Session dismissed. Its worktree is kept.' : 'Session dismissed and its worktree removed.'
}

export const CLOSE_PENDING = 'Closing the session…'
export const CLOSE_SUCCESS = 'Session closed.'
export const CLOSE_UNKNOWN_SESSION = "That session isn't running any more."

export function folderMissingToast(path: string | null): string {
  return path !== null ? `This session's folder is gone: ${path}` : "Port couldn't find this session's folder."
}

export const TASK_STOP_TITLE = 'Stop this background task?'
export function taskStopBody(description: string): string {
  return `"${description}" stops now. Claude is told it was stopped.`
}
export const TASK_KEEP_RUNNING = 'Keep running'
export const TASK_STOP_BUTTON = 'Stop task'
export const TASK_STOP_PENDING = 'Stopping the task…'
export const TASK_STOP_SUCCESS = 'Stopped the task.'
export const TASK_STOP_UNKNOWN = 'That task already finished.'
export function taskStopFailed(message: string): string {
  return `Couldn't stop the task: ${message}`
}
export const TASK_STOP_UNKNOWN_SESSION = 'This session has ended.'
