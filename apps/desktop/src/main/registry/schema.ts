// The registry's single point of contact with the config contract. Every
// consumer under src/main/registry/ reads CONFIG_DEFAULTS and validateConfig
// from here — never a hand-transcribed default or a second validator — so a
// renamed schema key fails `pnpm typecheck` here rather than silently
// resolving `undefined` somewhere else (ENGINEERING §1, decisions 1 and 2).
import Ajv2020 from 'ajv/dist/2020'
import schema from '../../../../../schema/port.config.schema.json'
import type { SchemaViolation } from '../../shared/repos'

const ajv = new Ajv2020({ allErrors: true })
const validate = ajv.compile(schema)

export interface ValidateConfigResult {
  readonly violations: readonly SchemaViolation[]
}

/** Runs the real, shipped schema over an untrusted parsed config. `allErrors`
 *  is set on the Ajv instance, so a config with three mistakes reports all
 *  three rather than stopping at the first. */
export function validateConfig(value: unknown): ValidateConfigResult {
  const isValid = validate(value)
  if (isValid) return { violations: [] }
  const violations = (validate.errors ?? []).map((error) => ({
    path: error.instancePath === '' ? '(document root)' : error.instancePath,
    message: error.message ?? 'is invalid',
  }))
  return { violations }
}

export interface ConfigDefaults {
  readonly branches: { readonly integration: string; readonly production: string }
  readonly models: { readonly plan: string; readonly impl: string; readonly review: string; readonly revise: string }
  readonly modules: {
    readonly approvalGate: boolean
    readonly previewDatabase: boolean
    readonly release: boolean
    readonly scope: boolean
  }
  readonly reviewCycleCap: number
}

/** Every default read off the schema import above — never a typed-out
 *  literal — so a schema edit that renames or removes a default is a
 *  compile error here, not a silently-`undefined` value at inspection
 *  time. */
export const CONFIG_DEFAULTS: ConfigDefaults = {
  branches: {
    integration: schema.properties.branches.properties.integration.default,
    production: schema.properties.branches.properties.production.default,
  },
  models: {
    plan: schema.properties.models.properties.plan.default,
    impl: schema.properties.models.properties.impl.default,
    review: schema.properties.models.properties.review.default,
    revise: schema.properties.models.properties.revise.default,
  },
  modules: {
    approvalGate: schema.properties.modules.properties.approvalGate.default,
    previewDatabase: schema.properties.modules.properties.previewDatabase.default,
    release: schema.properties.modules.properties.release.default,
    scope: schema.properties.modules.properties.scope.default,
  },
  reviewCycleCap: schema.properties.reviewCycleCap.default,
}
