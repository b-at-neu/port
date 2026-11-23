import type { z } from 'zod'
import { appInfo } from '@/main/features/app/actions/info'
import { reposList } from '@/main/features/repos/actions/list'
import { reposAdd } from '@/main/features/repos/actions/add'
import { reposRemove } from '@/main/features/repos/actions/remove'
import { worktreesReport } from '@/main/features/worktrees/actions/report'
import { worktreesReclaim } from '@/main/features/worktrees/actions/reclaim'
import { worktreesPurge } from '@/main/features/worktrees/actions/purge'
import { historyScan } from '@/main/features/history/actions/scan'
import { transcriptTailOpen } from '@/main/features/transcript/actions/tail-open'
import { transcriptTailPoll } from '@/main/features/transcript/actions/tail-poll'
import { transcriptTailClose } from '@/main/features/transcript/actions/tail-close'
import { searchQuery } from '@/main/features/search/actions/query'
import { boardSnapshot } from '@/main/features/board/actions/snapshot'
import { boardRefresh } from '@/main/features/board/actions/refresh'
import { claimPreflight } from '@/main/features/claim/actions/preflight'
import { claimApply } from '@/main/features/claim/actions/apply'
import { itemAction } from '@/main/features/item/actions/action'
import { itemDecide } from '@/main/features/item/actions/decide'
import { dispatchControl } from '@/main/features/dispatch/actions/control'
import { runtimePreflightAction } from '@/main/features/runtime/actions/preflight'
import { runtimeProbe } from '@/main/features/runtime/actions/probe'
import { gatePreflight } from '@/main/features/gate/actions/preflight'
import { gateAnswer } from '@/main/features/gate/actions/answer'
import { sessionStart } from '@/main/features/session/actions/start'
import { sessionSend } from '@/main/features/session/actions/send'
import { sessionInterrupt } from '@/main/features/session/actions/interrupt'
import { sessionClose } from '@/main/features/session/actions/close'
import { sessionAttach } from '@/main/features/session/actions/attach'
import { sessionList } from '@/main/features/session/actions/list'
import { sessionIndex } from '@/main/features/session/actions/index-list'
import { sessionPermissionAnswer } from '@/main/features/session/actions/permission-answer'
import { sessionInvoke } from '@/main/features/session/actions/invoke'
import { sessionDismiss } from '@/main/features/session/actions/dismiss'
import { sessionCapacity } from '@/main/features/session/actions/capacity'
import { sessionCapacitySet } from '@/main/features/session/actions/capacity-set'
import { sessionRestoreList } from '@/main/features/session/actions/restore-list'
import { sessionRestore } from '@/main/features/session/actions/restore'
import { sessionRestoreDiscard } from '@/main/features/session/actions/restore-discard'
import { sessionDefaults } from '@/main/features/session/actions/defaults'
import { sessionDefaultsSet } from '@/main/features/session/actions/defaults-set'
import { sessionRename } from '@/main/features/session/actions/rename'
import { sessionControlsSet } from '@/main/features/session/actions/controls-set'
import { sessionQuestionAnswer } from '@/main/features/session/actions/question-answer'
import { sessionPlanAnswer } from '@/main/features/session/actions/plan-answer'
import { sessionFiles } from '@/main/features/session/actions/files'
import { sessionChanges } from '@/main/features/session/actions/changes'
import { sessionMarks } from '@/main/features/session/actions/marks'
import { sessionPinSet } from '@/main/features/session/actions/pin-set'
import { sessionArchiveSet } from '@/main/features/session/actions/archive-set'
import { sessionTaskStop } from '@/main/features/session/actions/task-stop'
import { ghStatus } from '@/main/features/gh/actions/status'
import { backlogList } from '@/main/features/backlog/actions/list'
import { backlogDetail } from '@/main/features/backlog/actions/detail'
import { auditList } from '@/main/features/audit/actions/list'
import { incidentsGroups } from '@/main/features/incidents/actions/groups'
import { incidentsList } from '@/main/features/incidents/actions/list'
import { incidentsExport } from '@/main/features/incidents/actions/export'
import { foldersList } from '@/main/features/folders/actions/list'
import { foldersChoose } from '@/main/features/folders/actions/choose'
import { stageAllow } from '@/main/features/stage/actions/allow'
import { stageDismissDenial } from '@/main/features/stage/actions/dismiss-denial'
import { stageResume } from '@/main/features/stage/actions/resume'
import { stageRestart } from '@/main/features/stage/actions/restart'
import { heldForceDispatch } from '@/main/features/held/actions/force-dispatch'
import { notifyNeedsYou } from '@/main/features/notify/actions/needs-you'
import { notifyPrefs } from '@/main/features/notify/actions/prefs'
import { notifyPrefsSet } from '@/main/features/notify/actions/prefs-set'
import { storageReport } from '@/main/features/storage/actions/report'
import { usageSummary } from '@/main/features/usage/actions/summary'
import { releaseStatus } from '@/main/features/release/actions/status'
import { releaseIssues } from '@/main/features/release/actions/issues'
import { releaseRun } from '@/main/features/release/actions/run'
import { updateState } from '@/main/features/update/actions/state'
import { updateCheck } from '@/main/features/update/actions/check'
import { updateDownload } from '@/main/features/update/actions/download'
import { updateDownloadState } from '@/main/features/update/actions/download-state'
import { updateOpen } from '@/main/features/update/actions/open'

export { events } from '@/main/app/events'
export type { EventMap, EventName } from '@/main/app/events'

export const actions = [
  appInfo,
  reposList,
  reposAdd,
  reposRemove,
  worktreesReport,
  worktreesReclaim,
  worktreesPurge,
  historyScan,
  transcriptTailOpen,
  transcriptTailPoll,
  transcriptTailClose,
  searchQuery,
  boardSnapshot,
  boardRefresh,
  claimPreflight,
  claimApply,
  itemAction,
  itemDecide,
  dispatchControl,
  runtimePreflightAction,
  runtimeProbe,
  gatePreflight,
  gateAnswer,
  sessionStart,
  sessionSend,
  sessionInterrupt,
  sessionClose,
  sessionAttach,
  sessionList,
  sessionIndex,
  sessionPermissionAnswer,
  sessionInvoke,
  sessionDismiss,
  sessionCapacity,
  sessionCapacitySet,
  sessionRestoreList,
  sessionRestore,
  sessionRestoreDiscard,
  sessionDefaults,
  sessionDefaultsSet,
  sessionRename,
  sessionControlsSet,
  sessionQuestionAnswer,
  sessionPlanAnswer,
  sessionFiles,
  sessionChanges,
  sessionMarks,
  sessionPinSet,
  sessionArchiveSet,
  sessionTaskStop,
  ghStatus,
  backlogList,
  backlogDetail,
  auditList,
  incidentsGroups,
  incidentsList,
  incidentsExport,
  foldersList,
  foldersChoose,
  stageAllow,
  stageDismissDenial,
  stageResume,
  stageRestart,
  heldForceDispatch,
  notifyNeedsYou,
  notifyPrefs,
  notifyPrefsSet,
  storageReport,
  usageSummary,
  releaseStatus,
  releaseIssues,
  releaseRun,
  updateState,
  updateCheck,
  updateDownload,
  updateDownloadState,
  updateOpen,
] as const

type AnyAction = (typeof actions)[number]

/** Name → kind, request and response, all derived from the definitions above. */
export type ActionMap = {
  [A in AnyAction as A['name']]: { readonly kind: A['kind']; readonly input: z.input<A['input']>; readonly output: Awaited<ReturnType<A['run']>> }
}

export type ActionName = keyof ActionMap
export type QueryName = { [N in ActionName]: ActionMap[N]['kind'] extends 'query' ? N : never }[ActionName]
export type MutationName = Exclude<ActionName, QueryName>
