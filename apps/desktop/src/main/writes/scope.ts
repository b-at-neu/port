// Pure claim-scope derivation and precondition evaluation — no `gh`, no
// filesystem, no `git`. `scopeFor` derives the required claim scope from a
// request's own `add`/`remove` keys, never from a caller-declared field a
// caller could understate.
import type { LabelKey } from '../../shared/labels/vocabulary'
import type { AssigneeExpectation, ClaimScope, LabelWriteRequest, ObservedItem } from '../../shared/writes/types'

/** Byte-for-byte `docs/COORDINATION.md` → "The claim contract"'s own set —
 *  pinned both directions by `scripts/checks/desktop-writes.mjs`. `autoPlan`
 *  is deliberately excluded: the cockpit's opt-in path still sets it, and
 *  its auto-plan swap is already covered by `planApproved` being in the
 *  set. */
export const PLAN_GATE_KEYS: readonly LabelKey[] = ['planReview', 'planApproved', 'planChangesRequested']

/** `applyLabels` requires a held `plan-gate` claim iff `add ∪ remove`
 *  intersects `PLAN_GATE_KEYS`; every other label or assignee write is
 *  "either — convergent" per `docs/COORDINATION.md`'s ownership table and
 *  needs none (plan's own **Authorization, per entry point**). */
export function scopeFor(request: Pick<LabelWriteRequest, 'add' | 'remove'>): ClaimScope | null {
  const touched = new Set<LabelKey>([...request.add, ...request.remove])
  return PLAN_GATE_KEYS.some((key) => touched.has(key)) ? 'plan-gate' : null
}

export type PreconditionVerdict = { readonly satisfied: true } | { readonly satisfied: false; readonly expected: readonly string[]; readonly observed: readonly string[] }

function assigneesSatisfied(expectation: AssigneeExpectation, observedAssignees: readonly string[]): boolean {
  switch (expectation.kind) {
    case 'any':
      return true
    case 'unassigned':
      return observedAssignees.length === 0
    case 'exactly': {
      const expected = new Set(expectation.logins)
      const observed = new Set(observedAssignees)
      return expected.size === observed.size && [...expected].every((login) => observed.has(login))
    }
  }
}

function assigneeExpectationNames(expectation: AssigneeExpectation): readonly string[] {
  switch (expectation.kind) {
    case 'any':
      return []
    case 'unassigned':
      return ['unassigned']
    case 'exactly':
      return expectation.logins
  }
}

/** Display form for an `absentNames` entry — distinguishes "expected
 *  present" from "expected absent" in the flattened `expected` list, since
 *  both share the same `string[]` shape. */
function absentLabelName(name: string): string {
  return `not ${name}`
}

/** Evaluates an already name-resolved precondition against `observed`.
 *  `presentNames`/`absentNames` are the caller's `expect.present`/
 *  `expect.absent` keys, already resolved through `labelName` — this
 *  function never resolves a key itself, so it stays pure and label-key
 *  agnostic. `expected`/`observed` in the failing case are display names,
 *  exactly what the `Conflict` payload needs — `expected` always carries
 *  `presentNames` in full (the positive half of the expectation), plus
 *  whichever `absentNames` entries actually turned up (rendered
 *  `not <name>`) and the assignee expectation when *that* is what
 *  violated (including the `unassigned` case), so an absent-label or
 *  assignee violation is never silently missing from the payload. */
export function evaluate(
  precondition: { readonly presentNames: readonly string[]; readonly absentNames: readonly string[]; readonly assignees: AssigneeExpectation },
  observed: ObservedItem,
): PreconditionVerdict {
  const observedLabels = new Set(observed.labels)
  const missingPresent = precondition.presentNames.filter((name) => !observedLabels.has(name))
  const unexpectedlyPresent = precondition.absentNames.filter((name) => observedLabels.has(name))
  const assigneesOk = assigneesSatisfied(precondition.assignees, observed.assignees)

  if (missingPresent.length === 0 && unexpectedlyPresent.length === 0 && assigneesOk) {
    return { satisfied: true }
  }

  const expected = [
    ...precondition.presentNames,
    ...unexpectedlyPresent.map(absentLabelName),
    ...(assigneesOk ? [] : assigneeExpectationNames(precondition.assignees)),
  ]
  const observedNames = [...observed.labels, ...observed.assignees]
  return { satisfied: false, expected, observed: observedNames }
}

/** `no-op` when the write would change nothing observable: every `add` key's
 *  name is already present, every `remove` key's name is already absent,
 *  and no assignee change is requested. Pure over already-resolved names —
 *  `apply.ts` supplies them from the same resolution `command.ts` performed. */
export function wouldChangeNothing(
  request: { readonly addNames: readonly string[]; readonly removeNames: readonly string[]; readonly addAssignees: readonly string[]; readonly removeAssignees: readonly string[] },
  observed: ObservedItem,
): boolean {
  if (request.addAssignees.length > 0 || request.removeAssignees.length > 0) return false
  const observedLabels = new Set(observed.labels)
  const everyAddPresent = request.addNames.every((name) => observedLabels.has(name))
  const everyRemoveAbsent = request.removeNames.every((name) => !observedLabels.has(name))
  return everyAddPresent && everyRemoveAbsent
}
