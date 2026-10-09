// #99: the per-session permission broker — this handle's own `canUseTool`.
// Every call becomes a pending request on the handle's snapshot, settled by
// an operator answer (`answer`) or by the SDK's own `AbortSignal`, never by
// a timer of this broker's own: the wait is the SDK's, and the broker never
// decides for the operator (no park deadline — see `canUseTool`'s own
// doc comment on the SDK side).
import type { QuestionAnswerResult, PlanAnswerResult, PlanDecision } from '../../shared/hosting/controls'
import type { PendingPermission, PermissionDecision, SessionPermissionAnswerResult } from '../../shared/hosting/types'
import { narrowSessionGrant } from './grant'
import { answersMatch, narrowInteraction, planApproveResult, planKeepResult, questionResult } from './interactions'
import type { CanUseTool, PermissionResult, PermissionUpdate } from './sdk'

export const DEFAULT_DENY_MESSAGE = 'The operator denied this tool call.'

export interface CreatePermissionBrokerParams {
  readonly now: () => number
  readonly onChange: () => void
  // Fired after a plan is approved into a mode, so the controls snapshot reflects it without a second SDK call.
  readonly onPlanApproved?: (mode: 'default' | 'acceptEdits') => void
}

export interface PermissionBroker {
  /** Typed `Promise<PermissionResult>`, never `| null` — the SDK treats `null` as "already answered" and hangs. */
  readonly canUseTool: CanUseTool
  pending(): readonly PendingPermission[]
  answer(permissionId: string, decision: PermissionDecision, message: string | null): SessionPermissionAnswerResult
  answerQuestion(permissionId: string, answers: Readonly<Record<string, string>>): QuestionAnswerResult
  answerPlan(permissionId: string, decision: PlanDecision): PlanAnswerResult
  cancelAll(): void
}

interface Entry {
  readonly pending: PendingPermission
  readonly toolUseID: string
  readonly input: Readonly<Record<string, unknown>>
  readonly grantUpdates: readonly PermissionUpdate[] | null
  readonly resolve: (result: PermissionResult) => void
}

export function createPermissionBroker(params: CreatePermissionBrokerParams): PermissionBroker {
  const entries = new Map<string, Entry>()

  function pending(): readonly PendingPermission[] {
    return [...entries.values()].map((entry) => entry.pending).sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
  }

  function settle(permissionId: string, result: PermissionResult): void {
    const entry = entries.get(permissionId)
    if (!entry) return
    entries.delete(permissionId)
    entry.resolve(result)
    params.onChange()
  }

  const canUseTool: CanUseTool = (toolName, input, options) =>
    new Promise<PermissionResult>((resolve) => {
      const permissionId = globalThis.crypto.randomUUID()

      if (options.signal.aborted) {
        resolve({ behavior: 'deny', message: DEFAULT_DENY_MESSAGE, toolUseID: options.toolUseID })
        return
      }

      const grant = narrowSessionGrant(options.suggestions)
      const entry: Entry = {
        pending: {
          permissionId,
          toolName,
          input,
          title: options.title ?? null,
          displayName: options.displayName ?? null,
          description: options.description ?? null,
          decisionReason: options.decisionReason ?? null,
          blockedPath: options.blockedPath ?? null,
          agentId: options.agentID ?? null,
          requestedAt: new Date(params.now()).toISOString(),
          sessionGrant: grant?.summary ?? null,
          interaction: narrowInteraction(toolName, input),
        },
        toolUseID: options.toolUseID,
        input,
        grantUpdates: grant?.updates ?? null,
        resolve,
      }
      entries.set(permissionId, entry)

      options.signal.addEventListener(
        'abort',
        () => settle(permissionId, { behavior: 'deny', message: DEFAULT_DENY_MESSAGE, toolUseID: options.toolUseID }),
        { once: true },
      )

      params.onChange()
    })

  function answer(permissionId: string, decision: PermissionDecision, message: string | null): SessionPermissionAnswerResult {
    const entry = entries.get(permissionId)
    if (!entry) return { ok: false, kind: 'unknown-permission' }

    if (decision === 'deny') {
      settle(permissionId, { behavior: 'deny', message: message ?? DEFAULT_DENY_MESSAGE, toolUseID: entry.toolUseID })
      return { ok: true }
    }

    if (entry.pending.interaction !== null) return { ok: false, kind: 'interaction-prompt' }

    if (decision === 'allow-session') {
      if (entry.grantUpdates === null) return { ok: false, kind: 'no-session-grant' }
      settle(permissionId, { behavior: 'allow', updatedInput: entry.pending.input, updatedPermissions: [...entry.grantUpdates], toolUseID: entry.toolUseID })
      return { ok: true }
    }

    // 'allow-once'
    settle(permissionId, { behavior: 'allow', updatedInput: entry.pending.input, toolUseID: entry.toolUseID })
    return { ok: true }
  }

  function answerQuestion(permissionId: string, answers: Readonly<Record<string, string>>): QuestionAnswerResult {
    const entry = entries.get(permissionId)
    if (!entry) return { ok: false, kind: 'unknown-permission' }
    const interaction = entry.pending.interaction
    if (interaction === null || interaction.kind !== 'question') return { ok: false, kind: 'not-a-question' }
    if (!answersMatch(interaction, answers)) return { ok: false, kind: 'answers-mismatch' }
    settle(permissionId, questionResult(entry.input, answers, entry.toolUseID))
    return { ok: true }
  }

  function answerPlan(permissionId: string, decision: PlanDecision): PlanAnswerResult {
    const entry = entries.get(permissionId)
    if (!entry) return { ok: false, kind: 'unknown-permission' }
    const interaction = entry.pending.interaction
    if (interaction === null || interaction.kind !== 'plan') return { ok: false, kind: 'not-a-plan' }
    if (decision.kind === 'approve') {
      settle(permissionId, planApproveResult(entry.input, decision.mode, entry.toolUseID))
      params.onPlanApproved?.(decision.mode)
    } else {
      settle(permissionId, planKeepResult(decision.feedback, entry.toolUseID))
    }
    return { ok: true }
  }

  function cancelAll(): void {
    for (const [permissionId, entry] of [...entries]) {
      settle(permissionId, { behavior: 'deny', message: DEFAULT_DENY_MESSAGE, toolUseID: entry.toolUseID })
    }
  }

  return { canUseTool, pending, answer, answerQuestion, answerPlan, cancelAll }
}
