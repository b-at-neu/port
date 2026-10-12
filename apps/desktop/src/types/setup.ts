import type { PillStatus } from '@/types/components'

/** One query's own loading/error/data split, kept loose for easy testing. */
export interface QueryState<T> {
  readonly status: 'pending' | 'error' | 'success'
  readonly data?: T
}

type SetupStepState = 'loading' | 'done' | 'needs-you' | 'failed' | 'unreachable'

export interface SetupAction {
  readonly label: string
  readonly kind: 'test' | 'check-again' | 'add-repository'
}

export interface SetupStep {
  readonly state: SetupStepState
  readonly pillStatus: PillStatus
  readonly pillLabel: string
  readonly title: string
  readonly body: string
  /** A command embedded in `body`, rendered in mono between `body` and `bodySuffix`. */
  readonly bodyCommand: string | null
  readonly bodySuffix: string
  readonly detail: string | null
  readonly action: SetupAction | null
}
