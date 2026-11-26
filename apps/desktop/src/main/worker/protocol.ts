import type { StateEngine } from '@/main/pipeline/context'

export const OFFLOAD_OPS = [
  'refreshSessions',
  'refreshWorktrees',
  'refreshDenials',
  'refreshGithub',
  'precheckGithub',
  'project',
  'scanSessions',
  'listSessions',
  'search',
  'tailOpen',
  'tailPoll',
  'tailClose',
  'forgetRepo',
] as const satisfies readonly (keyof StateEngine)[]

export type OffloadOp = (typeof OFFLOAD_OPS)[number]

export type OffloadParams = { [K in OffloadOp]: Parameters<StateEngine[K]>[0] }

export type OffloadValue = { [K in OffloadOp]: Awaited<ReturnType<StateEngine[K]>> }

export interface OffloadRequest {
  readonly id: number
  readonly op: string
  readonly params: unknown
}

export type OffloadResponse =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly message: string }
