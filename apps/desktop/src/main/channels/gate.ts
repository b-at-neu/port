// Forces one `board:refresh` on an `applied` label outcome; a refresh failure is swallowed and
// logged so it can never mask the write's own success.
import { GATE_DECISIONS } from '../../shared/gate/types'
import type { GateAnswerResponse, GateDecision, GatePreflightResponse } from '../../shared/gate/types'
import type { BoardSnapshot } from '../../shared/board/types'
import type { IpcMap } from '../../shared/ipc'
import type { RegistryDeps } from '../registry'
import { requireRepoId } from '../registry'
import type { GateAnswerParams, GatePreflightParams } from '../actions/gate'

export interface GateChannelDeps {
  readonly gatePreflight: (params: GatePreflightParams) => Promise<GatePreflightResponse>
  readonly gateAnswer: (params: GateAnswerParams) => Promise<GateAnswerResponse>
  readonly refresh: (request: IpcMap['board:refresh']['request']) => Promise<BoardSnapshot>
}

export async function resolveGatePreflight(registryDeps: RegistryDeps, request: IpcMap['gate:preflight']['request'], deps: GateChannelDeps): Promise<GatePreflightResponse> {
  const repoId = requireRepoId(request?.repoId, "'gate:preflight'")
  if (!Number.isInteger(request.number) || request.number <= 0) {
    throw new Error("'gate:preflight' requires 'number' to be a positive integer")
  }
  return deps.gatePreflight({ registryDeps, repoId, number: request.number })
}

function isGateDecision(value: unknown): value is GateDecision {
  return (GATE_DECISIONS as readonly string[]).includes(value as string)
}

export async function resolveGateAnswer(
  registryDeps: RegistryDeps,
  request: IpcMap['gate:answer']['request'],
  auditDir: string,
  scratchDir: string,
  deps: GateChannelDeps,
): Promise<GateAnswerResponse> {
  const repoId = requireRepoId(request?.repoId, "'gate:answer'")
  if (!Number.isInteger(request.number) || request.number <= 0) {
    throw new Error("'gate:answer' requires 'number' to be a positive integer")
  }
  if (!isGateDecision(request.decision)) {
    throw new Error(`'gate:answer' requires 'decision' to be one of ${GATE_DECISIONS.join(', ')}`)
  }
  if (typeof request.skipComment !== 'boolean') {
    throw new Error("'gate:answer' requires 'skipComment' to be a boolean")
  }
  const feedbackRequired = request.decision === 'request-changes' && !request.skipComment
  if (feedbackRequired && (typeof request.feedback !== 'string' || request.feedback.trim() === '')) {
    throw new Error("'gate:answer' requires a non-empty 'feedback' when 'decision' is 'request-changes' and 'skipComment' is false")
  }

  const result = await deps.gateAnswer({
    registryDeps,
    repoId,
    number: request.number,
    decision: request.decision,
    feedback: request.feedback ?? null,
    skipComment: request.skipComment,
    auditDir,
    scratchDir,
  })

  if (result.kind === 'answered' && result.labels.kind === 'applied') {
    try {
      await deps.refresh({ repoId, source: 'github' })
    } catch (error) {
      console.error(`'gate:answer' post-write refresh failed for '${repoId}':`, error)
    }
  }
  return result
}
