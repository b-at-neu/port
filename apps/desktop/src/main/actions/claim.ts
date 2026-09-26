// applyClaimLabels — the claim dialog's own `applyLabels` caller, relocated
// out of `main/claim.ts` to retire the grandfathered second-caller exception
// `docs/ENGINEERING.md` §1 names (#92): `main/actions/` becomes the app's
// only `applyLabels` caller, with none left outside it. Behaviour-identical —
// a direct pass-through to `main/writes/`'s own chokepoint, with no logic of
// its own. `main/claim.ts`'s preflight, verdict, and `moved` logic are
// untouched; only the write call itself moved.
import { applyLabels } from '../writes'
import type { ApplyLabelsParams } from '../writes'
import type { WriteOutcome } from '../../shared/writes/types'

export async function applyClaimLabels(params: ApplyLabelsParams): Promise<WriteOutcome> {
  return applyLabels(params)
}
