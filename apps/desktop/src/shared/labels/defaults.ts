// The deliberate single point of contact with the shipped template: every
// other file under labels/ reads LABEL_DEFAULTS below, never this relative
// import or `plugins/port/templates/labels.json` directly.
import template from '../../../../../plugins/port/templates/labels.json'
import type { LabelKey } from './vocabulary'

/**
 * Modules a label default can be gated behind, mirroring `port.config.json`'s
 * `modules` keys plus the `core` sentinel for a label that is always
 * created regardless of config.
 */
export const LABEL_MODULES = ['core', 'approvalGate', 'release', 'scope'] as const
export type LabelModule = (typeof LABEL_MODULES)[number]

/**
 * `labels.json`'s own machine-readable authority on what kind of label each
 * one is — PIPELINE.md's two label tables transcribed as data, never as a
 * fourth prose copy (#79 Decision 1). `scripts/checks/labels.mjs` pins this
 * against `labels.json`'s real `role` values, both directions.
 */
export const LABEL_ROLES = ['marker', 'trigger', 'in-flight', 'gate', 'terminal'] as const
export type LabelRole = (typeof LABEL_ROLES)[number]

export interface LabelDefault {
  readonly key: LabelKey
  readonly name: string
  readonly module: LabelModule
  readonly color: string
  readonly role: LabelRole
  readonly description: string
}

// This does not cross-check against `LABEL_KEYS` — that would need a runtime
// (not merely type-level) import from vocabulary.ts, and this module is
// reachable from the renderer, where a load-time throw on a mismatch is a
// white screen. The both-directions agreement between this template and
// `LABEL_KEYS` is asserted at test time (vocabulary.test.ts) and at
// `scripts/checks.mjs` time (`desktop-label-defaults`) instead.
function isLabelDefault(entry: unknown): entry is LabelDefault {
  if (typeof entry !== 'object' || entry === null) return false
  const candidate = entry as Record<string, unknown>
  const modules = LABEL_MODULES as readonly string[]
  const roles = LABEL_ROLES as readonly string[]
  return (
    typeof candidate.key === 'string' &&
    candidate.key.length > 0 &&
    typeof candidate.name === 'string' &&
    typeof candidate.module === 'string' &&
    modules.includes(candidate.module) &&
    typeof candidate.color === 'string' &&
    typeof candidate.role === 'string' &&
    roles.includes(candidate.role) &&
    typeof candidate.description === 'string'
  )
}

// Cast to `unknown[]` before filtering: TypeScript's generic filter overload
// requires `LabelDefault` to extend the JSON's own inferred element type,
// which is `string` for every field the JSON import widens. The predicate
// itself still verifies every field this module actually needs.
export const LABEL_DEFAULTS: readonly LabelDefault[] = (template.labels as unknown[]).filter(isLabelDefault)
