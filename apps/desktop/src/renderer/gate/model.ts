import type { GatePreflight, GatePreflightResponse, GateVerdict } from '@/types/gate'
import type { OwnershipSummary } from '@/types/writes'
import { PREFLIGHT_UNREACHABLE } from '@/renderer/gate/copy'

type AnswerableVerdict = Extract<GateVerdict, { readonly kind: 'answerable' }>
type RefusalVerdict = Exclude<GateVerdict, { readonly kind: 'answerable' }>

export type GateStep =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'refused'; readonly verdict: RefusalVerdict }
  | { readonly kind: 'reviewing'; readonly preflight: GatePreflight; readonly verdict: AnswerableVerdict; readonly ownership: OwnershipSummary }

interface PreflightQuery {
  readonly data: GatePreflightResponse | undefined
  readonly isError: boolean
  readonly isFetching: boolean
}

export function gateStepOf({ data, isError, isFetching }: PreflightQuery): GateStep {
  if (isFetching) return { kind: 'loading' }
  if (isError) return { kind: 'failed', message: PREFLIGHT_UNREACHABLE }
  if (data === undefined) return { kind: 'loading' }
  if (data.kind === 'failed') return { kind: 'failed', message: data.message }
  if (data.kind === 'unresolved') return { kind: 'refused', verdict: { kind: 'not-found' } }
  if (data.verdict.kind !== 'answerable') return { kind: 'refused', verdict: data.verdict }
  return { kind: 'reviewing', preflight: data.preflight, verdict: data.verdict, ownership: data.ownership }
}
