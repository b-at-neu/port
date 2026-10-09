// The per-session controls tracker — live mode/model/effort state, changed
// only once its SDK call actually resolves.
import { isRecord } from '../../shared/guards'
import type { SessionControls, SessionEffort, SessionModelOption, SessionModels } from '../../shared/hosting/controls'
import { SESSION_EFFORTS } from '../../shared/hosting/controls'
import type { SessionDefaults } from '../../shared/hosting/types'
import type { HostedQuery, ModelInfo } from './sdk'

// A stalled supportedModels() call must never park the model select forever.
export const MODELS_TIMEOUT_MS = 30_000

export interface CreateControlsTrackerParams {
  readonly defaults: SessionDefaults
  readonly onChange: () => void
  readonly timeoutMs?: number
}

export interface ControlsTracker {
  start(query: HostedQuery): Promise<void>
  observe(message: unknown): void
  current(): SessionControls
  models(): SessionModels
  // One SDK call per changed field, mode -> model -> effort; a rejection leaves every field at its last confirmed value.
  set(query: HostedQuery, patch: { readonly permissionMode?: SessionControls['permissionMode']; readonly model?: string; readonly effort?: SessionEffort | null }): Promise<
    { readonly ok: true; readonly controls: SessionControls } | { readonly ok: false; readonly kind: 'unknown-model' | 'unsupported-effort' } | { readonly ok: false; readonly kind: 'rejected'; readonly message: string }
  >
  adoptApprovedMode(mode: SessionControls['permissionMode']): void
}

function timeoutRejection(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    AbortSignal.timeout(ms).addEventListener('abort', () => reject(new Error(`Timed out after ${ms}ms waiting for this session's model list`)), { once: true })
  })
}

function toModelOption(info: ModelInfo): SessionModelOption {
  const efforts = (info.supportedEffortLevels ?? []).filter((level): level is SessionEffort => (SESSION_EFFORTS as readonly string[]).includes(level))
  return { value: info.value, displayName: info.displayName, description: info.description, efforts }
}

export function createControlsTracker(params: CreateControlsTrackerParams): ControlsTracker {
  let controls: SessionControls = { permissionMode: params.defaults.permissionMode, model: params.defaults.model, effort: null }
  let modelsState: SessionModels = { kind: 'pending' }
  let adopted = false

  async function start(query: HostedQuery): Promise<void> {
    try {
      const raw = await Promise.race([query.supportedModels(), timeoutRejection(params.timeoutMs ?? MODELS_TIMEOUT_MS)])
      modelsState = { kind: 'ready', models: raw.map(toModelOption) }
    } catch (error) {
      modelsState = { kind: 'unavailable', message: error instanceof Error ? error.message : String(error) }
    }
    params.onChange()
  }

  function observe(message: unknown): void {
    if (adopted || !isRecord(message) || message['type'] !== 'system' || message['subtype'] !== 'init') return
    adopted = true
    const permissionMode = message['permissionMode']
    const model = message['model']
    controls = {
      permissionMode: typeof permissionMode === 'string' ? (permissionMode as SessionControls['permissionMode']) : controls.permissionMode,
      model: typeof model === 'string' ? model : controls.model,
      effort: controls.effort,
    }
    params.onChange()
  }

  function modelOption(value: string): SessionModelOption | null {
    if (modelsState.kind !== 'ready') return null
    return modelsState.models.find((candidate) => candidate.value === value) ?? null
  }

  async function set(
    query: HostedQuery,
    patch: { readonly permissionMode?: SessionControls['permissionMode']; readonly model?: string; readonly effort?: SessionEffort | null },
  ): ReturnType<ControlsTracker['set']> {
    const nextModel = patch.model ?? controls.model
    if (patch.model !== undefined && modelOption(patch.model) === null) return { ok: false, kind: 'unknown-model' }

    let nextEffort = patch.effort !== undefined ? patch.effort : controls.effort
    if (nextEffort !== null) {
      const option = nextModel !== null ? modelOption(nextModel) : null
      if (option === null || !option.efforts.includes(nextEffort)) {
        if (patch.effort !== undefined) return { ok: false, kind: 'unsupported-effort' }
        // The model changed out from under an effort it no longer supports — clear it rather than refuse the model change.
        nextEffort = null
      }
    }

    try {
      if (patch.permissionMode !== undefined) await query.setPermissionMode(patch.permissionMode)
      if (patch.model !== undefined) await query.setModel(patch.model)
      if (nextEffort !== controls.effort) await query.applyFlagSettings({ effortLevel: nextEffort })
    } catch (error) {
      return { ok: false, kind: 'rejected', message: error instanceof Error ? error.message : String(error) }
    }

    controls = { permissionMode: patch.permissionMode ?? controls.permissionMode, model: nextModel, effort: nextEffort }
    params.onChange()
    return { ok: true, controls }
  }

  function adoptApprovedMode(mode: SessionControls['permissionMode']): void {
    controls = { ...controls, permissionMode: mode }
    params.onChange()
  }

  return { start, observe, current: () => controls, models: () => modelsState, set, adoptApprovedMode }
}
