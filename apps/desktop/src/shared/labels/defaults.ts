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
export const LABEL_MODULES = ['core', 'approvalGate', 'previewDatabase', 'release', 'scope'] as const
export type LabelModule = (typeof LABEL_MODULES)[number]

export interface LabelDefault {
  readonly key: LabelKey
  readonly name: string
  readonly module: LabelModule
  readonly color: string
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
  return (
    typeof candidate.key === 'string' &&
    candidate.key.length > 0 &&
    typeof candidate.name === 'string' &&
    typeof candidate.module === 'string' &&
    modules.includes(candidate.module) &&
    typeof candidate.color === 'string' &&
    typeof candidate.description === 'string'
  )
}

export const LABEL_DEFAULTS: readonly LabelDefault[] = template.labels.filter(isLabelDefault)
