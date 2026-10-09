// Pure precondition evaluation — no `gh`, no filesystem, no `git`.
import type { AssigneeExpectation, ObservedItem } from '../../shared/writes/types'

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

/** Distinguishes "expected present" from "expected absent" in the flattened `expected` list. */
function absentLabelName(name: string): string {
  return `not ${name}`
}

// Never resolves a key itself, so it stays pure and label-key agnostic.
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

/** `no-op` when every `add` key's name is already present, every `remove` key's name is already
 *  absent, and no assignee change is requested. */
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
