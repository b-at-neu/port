import { createStore, useStore } from '@/renderer/lib/store'
import type { RepoId } from '@/utils/repos'

export interface GateTarget {
  readonly repoId: RepoId
  readonly number: number
}

const gateTarget = createStore<GateTarget | null>(null)

export function openReviewDialog(repoId: RepoId, number: number): void {
  gateTarget.set({ repoId, number })
}

export function closeGateDialog(): void {
  gateTarget.set(null)
}

export function useGateTarget(): GateTarget | null {
  return useStore(gateTarget)
}
