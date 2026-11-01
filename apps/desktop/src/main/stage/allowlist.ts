// "Allow from now on": the pure merge of a stage denial's proposed rule into the texts of
// `.claude/settings.json` and `.claude/port.config.json`. No I/O — the caller reads and writes.
import { validateRule } from '@/main/stage/rule'

export const SETTINGS_PATH = '.claude/settings.json'
export const CONFIG_PATH = '.claude/port.config.json'

interface MergeRuleParams {
  /** `null` when the file doesn't exist at the ref — treated as an empty allowlist. */
  readonly settingsText: string | null
  readonly configText: string
  readonly rule: string
}

export type MergeRuleResult =
  | { readonly kind: 'already-allowed' }
  | { readonly kind: 'invalid-rule'; readonly reason: string }
  | { readonly kind: 'unparseable'; readonly file: string }
  | { readonly kind: 'files'; readonly rule: string; readonly files: readonly { readonly path: string; readonly content: string }[] }

type Obj = Readonly<Record<string, unknown>>

function parseObject(text: string): Obj | null {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Obj) : null
  } catch {
    return null
  }
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function serialized(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** Validates `rule` (the renderer's edit is never trusted), then returns only the files that lack it, keeping every other key and the existing order. A missing `port.config.json` is `unparseable`, since the repository isn't port-managed at that ref. */
export function mergeRule(params: MergeRuleParams): MergeRuleResult {
  const settings = params.settingsText === null ? { permissions: { allow: [] } } : parseObject(params.settingsText)
  if (settings === null) return { kind: 'unparseable', file: SETTINGS_PATH }
  const config = parseObject(params.configText)
  if (config === null) return { kind: 'unparseable', file: CONFIG_PATH }

  const permissions = typeof settings.permissions === 'object' && settings.permissions !== null && !Array.isArray(settings.permissions) ? (settings.permissions as Obj) : {}
  const currentAllow = strings(permissions.allow)
  const currentExtra = strings(config.extraAllow)

  const validated = validateRule(params.rule)
  if (!validated.ok) return { kind: 'invalid-rule', reason: validated.reason }
  const rule = validated.rule

  const files: { path: string; content: string }[] = []
  if (!currentAllow.includes(rule)) files.push({ path: SETTINGS_PATH, content: serialized({ ...settings, permissions: { ...permissions, allow: [...currentAllow, rule] } }) })
  if (!currentExtra.includes(rule)) files.push({ path: CONFIG_PATH, content: serialized({ ...config, extraAllow: [...currentExtra, rule] }) })
  return files.length === 0 ? { kind: 'already-allowed' } : { kind: 'files', rule, files }
}
