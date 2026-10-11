// Pure array transforms for a repository's own stage-denial bookkeeping — split out of
// dispatcher.ts to keep it under the file-size ceiling (docs/ENGINEERING.md §7).
import type { StageDenial } from '../../shared/stage/types'

export const DENIAL_LIMIT = 20

/** A new denial for an already-proposed rule replaces the old one, rather than piling up a second row for the same prompt. Bounded to `DENIAL_LIMIT`, dropping the oldest first. */
export function withDenial(denials: readonly StageDenial[], denial: StageDenial): readonly StageDenial[] {
  const deduped = denials.filter((d) => d.rule !== denial.rule)
  const next = [...deduped, denial]
  return next.length > DENIAL_LIMIT ? next.slice(next.length - DENIAL_LIMIT) : next
}

export function withoutDenialId(denials: readonly StageDenial[], id: string): readonly StageDenial[] {
  return denials.filter((d) => d.id !== id)
}

export function withoutDenialRule(denials: readonly StageDenial[], rule: string): readonly StageDenial[] {
  return denials.filter((d) => d.rule !== rule)
}
