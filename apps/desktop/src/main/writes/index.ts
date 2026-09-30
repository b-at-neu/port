// The write chokepoint's public surface — no consumer imports `./apply`,
// `./claim`, `./command`, `./scope`, or `./audit` directly. The mirror of
// `main/github/index.ts`'s own reader rail.
export { applyLabels, postComment } from './apply'
export type { ApplyLabelsParams, GhRunner, PostCommentParams } from './apply'

export { readGateClaim, releaseGateClaim, takeGateClaim } from './claim'
export type { GitRunner as ClaimGitRunner, ReadGateClaimParams, ReleaseGateClaimParams, TakeGateClaimParams } from './claim'

export { readAuditLog } from './audit'
export type { AppendAuditResult } from './audit'

export { PLAN_GATE_KEYS, scopeFor } from './scope'

export type {
  AssigneeExpectation,
  AuditEntry,
  AuditRead,
  AuditReadFailureKind,
  ClaimRead,
  ClaimScope,
  ClaimWriteFailureKind,
  ClaimWriteResult,
  CommentRequest,
  Conflict,
  GhWriteFailureKind,
  HeldClaim,
  LabelPrecondition,
  LabelWriteRequest,
  ObservedItem,
  ReadAuditLogParams,
  WriteOutcome,
} from '../../shared/writes/types'
