// The deliberate single point of contact with the shipped template: every other file under labels/ reads LABEL_DEFAULTS below, never this import directly.
import template from '../../../../../plugins/port/data/labels.json'
import type { LabelKey } from './vocabulary'

/** Modules a label default can be gated behind, plus the `core` sentinel for a label always created regardless of config. */
export const LABEL_MODULES = ['core', 'approvalGate', 'release', 'scope'] as const
export type LabelModule = (typeof LABEL_MODULES)[number]

/** `labels.json`'s own machine-readable authority on what kind of label each one is. */
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

// Does not cross-check against `LABEL_KEYS` — a runtime import would risk a load-time throw reaching the renderer as a white screen; the agreement is asserted at test time instead.
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

// Cast to `unknown[]` before filtering: a JSON import's inferred element type widens every field to `string`, which `LabelDefault` cannot extend directly.
export const LABEL_DEFAULTS: readonly LabelDefault[] = (template.labels as unknown[]).filter(isLabelDefault)
