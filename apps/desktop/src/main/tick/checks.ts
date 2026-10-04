// Pure: the statusCheckRollup reduction contract from
// plugins/port/docs/PIPELINE.md → "Check evidence" — ported verbatim from
// scripts/port-tick/checks.ts's own `reduceRollup`/`isConcluded`/
// `conclusionOf`/`rollupVerdict`, pinned against that file one-directionally
// by scripts/checks/desktop-tick.ts's dynamic import, the same idiom
// gates.ts already uses. Reduces to the latest entry per check name, then
// reads the verdict — never trusting an empty rollup as green, and never
// reading an excused check as absent from the record.
import type { CheckContext } from '../../shared/github/types'

const GREEN = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])

/** `(.name // .context)` — already flattened onto `CheckContext.name` at
 *  read time (`main/github/map.ts`), so this is a bare field read here. */
function nameOf(c: CheckContext): string | null {
  return c.name
}

/** The sortable moment a context reports itself at: `startedAt` for a
 *  CheckRun, falling back to `completedAt`, then a StatusContext's
 *  `createdAt` — whichever this union member actually carries. */
function timeOf(c: CheckContext): string | null {
  return c.startedAt ?? c.completedAt ?? c.createdAt
}

/** Reduces a rollup's contexts to the latest entry per check name by
 *  `timeOf`, since the approval gate alone re-runs on every labeled event and
 *  a pull request that has been through a few label changes can carry
 *  several entries for the same name. */
export function reduceRollup(contexts: readonly CheckContext[] | undefined): readonly CheckContext[] {
  const latest = new Map<string, CheckContext>()
  for (const c of contexts ?? []) {
    const name = nameOf(c)
    if (name === null) continue
    const t = timeOf(c)
    const prior = latest.get(name)
    if (prior === undefined || (t ?? '') > (timeOf(prior) ?? '')) latest.set(name, c)
  }
  return [...latest.values()]
}

/** Concluded is `status == 'COMPLETED'` for a CheckRun, or `state !=
 *  'PENDING'` for a StatusContext. */
export function isConcluded(entry: CheckContext): boolean {
  if (entry.__typename === 'StatusContext') return entry.state !== 'PENDING'
  return entry.status === 'COMPLETED'
}

/** `(.conclusion // .state)` — CheckRun's conclusion, or a StatusContext's
 *  state, whichever this entry carries. */
export function conclusionOf(entry: CheckContext): string | null {
  return entry.conclusion ?? entry.state
}

/** A single check's disposition (#246's map, generalizing the one derived
 *  approval-gate carve-out): `blocking` (the default — a red conclusion
 *  forms a finding and blocks) or `infrastructure` (red is reported, forms no
 *  finding, never blocks). `source` names where the disposition came from,
 *  since an excused check is always listed with it. */
export interface Disposition {
  readonly disposition: 'blocking' | 'infrastructure'
  readonly source: 'approval-gate' | 'CLAUDE.md'
}

export interface RollupVerdict {
  readonly pending: boolean
  readonly zeroEvidence?: boolean
  readonly red: readonly { readonly name: string | null; readonly conclusion: string | null }[]
  readonly green: readonly (string | null)[]
  readonly excused: readonly { readonly name: string | null; readonly conclusion: string | null; readonly source: Disposition['source'] }[]
  readonly unmatched: readonly string[]
}

/** Reduces `contexts` (the rollup's own `contexts.nodes`, already flattened
 *  at read time) to a verdict against `dispositions` — a map from check name
 *  to `Disposition` (`main/registry/inspect.ts`'s own `checkDispositions`,
 *  carried onto `ResolvedRepoConfig`: the approval-gate's own derived excusal
 *  folded in as `source: 'approval-gate'`). An empty rollup is pending,
 *  never green.
 *
 *  `excused` names every disposition-excused check still found in the
 *  rollup, with its real conclusion and source — nothing an excused check
 *  reported is ever dropped from a listing. `unmatched` names a disposition
 *  entry whose check never appeared in the reduced rollup at all — reported,
 *  never treated as satisfied. **Zero evidence**: when the rollup is
 *  non-empty but every entry in it was excused, the verdict is `pending`
 *  with `zeroEvidence: true`, never green. */
export function rollupVerdict(contexts: readonly CheckContext[] | null, dispositions: Readonly<Record<string, Disposition>> = {}): RollupVerdict {
  if (contexts === null || contexts.length === 0) return { pending: true, red: [], green: [], excused: [], unmatched: [] }

  const reduced = reduceRollup(contexts)
  const isExcused = (e: CheckContext): boolean => dispositions[nameOf(e) ?? '']?.disposition === 'infrastructure'

  const blocking = reduced.filter((e) => !isExcused(e))
  const excused = reduced
    .filter((e) => isExcused(e))
    .map((e) => {
      const name = nameOf(e)
      // Defensive: `isExcused` already confirmed `dispositions[name]` exists
      // for every entry in this list.
      const source = dispositions[name ?? '']?.source ?? 'approval-gate'
      return { name, conclusion: conclusionOf(e), source }
    })

  const reducedNames = new Set(reduced.map(nameOf))
  const unmatched = Object.entries(dispositions)
    .filter(([name, d]) => d.disposition === 'infrastructure' && !reducedNames.has(name))
    .map(([name]) => name)

  const pending = blocking.some((e) => !isConcluded(e))
  const red = blocking.filter((e) => isConcluded(e) && !GREEN.has(conclusionOf(e) ?? '')).map((e) => ({ name: nameOf(e), conclusion: conclusionOf(e) }))
  const green = blocking.filter((e) => isConcluded(e) && GREEN.has(conclusionOf(e) ?? '')).map((e) => nameOf(e))

  if (blocking.length === 0 && excused.length > 0) {
    return { pending: true, zeroEvidence: true, red: [], green: [], excused, unmatched }
  }

  return { pending: pending && red.length === 0, red, green, excused, unmatched }
}
