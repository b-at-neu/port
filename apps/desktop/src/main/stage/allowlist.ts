// "Allow from now on" writes: the one place a stage denial's proposed rule is appended to both
// `.claude/settings.json` and `.claude/port.config.json`, in the repository's main checkout.
import { join } from 'node:path'
import type { StageAllowResult } from '../../shared/stage/types'
import { validateRule } from '../../shared/stage/rule'
import type { FileResult } from '../platform/files'

interface SettingsShape {
  readonly permissions?: { readonly allow?: readonly unknown[]; readonly [k: string]: unknown }
  readonly [k: string]: unknown
}

interface ConfigShape {
  readonly extraAllow?: readonly unknown[]
  readonly [k: string]: unknown
}

export interface AllowRuleParams {
  readonly root: string
  readonly rule: string
  readonly readJson: <T>(path: string) => Promise<FileResult<T>>
  readonly writeJsonAtomic: (path: string, value: unknown) => Promise<FileResult<void>>
}

function allowListOf(shape: SettingsShape): readonly string[] {
  const allow = shape.permissions?.allow
  return Array.isArray(allow) ? allow.filter((v): v is string => typeof v === 'string') : []
}

function extraAllowOf(shape: ConfigShape): readonly string[] {
  return Array.isArray(shape.extraAllow) ? shape.extraAllow.filter((v): v is string => typeof v === 'string') : []
}

/** `allowRule({ root, rule, readJson, writeJsonAtomic })` — validates `rule` main-side (the renderer's edit is never trusted), then appends it to whichever of the two files lacks it, preserving every other key and the existing order. Settings is written first, then config. A config write failure after a settings success returns `write-failed` naming `port.config.json`, leaving settings written. */
export async function allowRule(params: AllowRuleParams): Promise<StageAllowResult> {
  const settingsPath = join(params.root, '.claude', 'settings.json')
  const configPath = join(params.root, '.claude', 'port.config.json')

  const settingsRead = await params.readJson<SettingsShape>(settingsPath)
  const settings: SettingsShape = settingsRead.ok ? settingsRead.value : settingsRead.kind === 'not-found' ? { permissions: { allow: [] } } : (null as unknown as SettingsShape)
  if (settings === null) return { kind: 'write-failed', file: 'settings.json', message: !settingsRead.ok ? settingsRead.message : 'unreadable' }

  const configRead = await params.readJson<ConfigShape>(configPath)
  if (!configRead.ok) return { kind: 'write-failed', file: 'port.config.json', message: configRead.message }
  const config = configRead.value

  const currentAllow = allowListOf(settings)
  const currentExtra = extraAllowOf(config)

  const validated = validateRule(params.rule, [...currentAllow, ...currentExtra])
  if (!validated.ok) {
    if (validated.reason === 'already-allowed') return { kind: 'already-allowed' }
    return { kind: 'invalid-rule', reason: validated.reason }
  }
  const rule = validated.rule

  const inSettings = currentAllow.includes(rule)
  const inConfig = currentExtra.includes(rule)
  if (inSettings && inConfig) return { kind: 'already-allowed' }

  if (!inSettings) {
    const nextSettings: SettingsShape = { ...settings, permissions: { ...settings.permissions, allow: [...currentAllow, rule] } }
    const write = await params.writeJsonAtomic(settingsPath, nextSettings)
    if (!write.ok) return { kind: 'write-failed', file: 'settings.json', message: write.message }
  }

  if (!inConfig) {
    const nextConfig: ConfigShape = { ...config, extraAllow: [...currentExtra, rule] }
    const write = await params.writeJsonAtomic(configPath, nextConfig)
    if (!write.ok) return { kind: 'write-failed', file: 'port.config.json', message: write.message }
  }

  return { kind: 'ok' }
}
