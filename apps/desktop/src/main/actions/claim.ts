// The claim dialog's only `applyLabels` caller; a pass-through with no logic of its own.
import { applyLabels } from '@/main/writes/apply'
import type { ApplyLabelsParams } from '@/main/writes/apply'
import type { WriteOutcome } from '@/shared/writes/types'

export async function applyClaimLabels(params: ApplyLabelsParams): Promise<WriteOutcome> {
  return applyLabels(params)
}
