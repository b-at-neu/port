import type { ApplyLabelsParams } from '@/types/writes'

// Work on's claim is the only `applyLabels` caller here; a pass-through with no logic of its own.
import { applyLabels } from '@/main/writes/apply'

import type { WriteOutcome } from '@/types/writes'

export async function applyClaimLabels(params: ApplyLabelsParams): Promise<WriteOutcome> {
  return applyLabels(params)
}
