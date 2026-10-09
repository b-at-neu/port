// Pure option lists and the mode cycle for the controls bar — no DOM, no IPC.
import type { SessionControls, SessionEffort, SessionModels } from '../../../shared/hosting/controls'
import type { SessionPermissionMode } from '../../../shared/hosting/types'

// Shift+Tab's own cycle: default (ask before edits) -> acceptEdits -> plan -> default.
export const MODE_CYCLE: readonly SessionPermissionMode[] = ['default', 'acceptEdits', 'plan']

export function nextMode(current: SessionPermissionMode): SessionPermissionMode {
  const index = MODE_CYCLE.indexOf(current)
  return MODE_CYCLE[(index + 1) % MODE_CYCLE.length] as SessionPermissionMode
}

export interface ModeOption {
  readonly value: SessionPermissionMode
  readonly label: string
}

export const MODE_OPTIONS: readonly ModeOption[] = [
  { value: 'default', label: 'Ask before edits' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan mode' },
]

export interface ModelSelectOption {
  readonly value: string
  readonly label: string
}

// A null currentModel offers a leading "Default" option, only before any change has been made.
export function modelOptions(models: SessionModels, currentModel: string | null): readonly ModelSelectOption[] {
  if (models.kind !== 'ready') return []
  const options = models.models.map((model) => ({ value: model.value, label: model.displayName }))
  return currentModel === null ? [{ value: '', label: 'Default' }, ...options] : options
}

// Empty when the chosen model lists no effort levels; the controls bar hides the effort select then.
export function effortOptions(models: SessionModels, model: string | null): readonly SessionEffort[] {
  if (models.kind !== 'ready' || model === null) return []
  return models.models.find((candidate) => candidate.value === model)?.efforts ?? []
}

export function modelDisplayName(models: SessionModels, value: string | null): string {
  if (value === null) return 'Default'
  if (models.kind !== 'ready') return value
  return models.models.find((candidate) => candidate.value === value)?.displayName ?? value
}

export function modeLabel(mode: SessionPermissionMode): string {
  return MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode
}

export function effortLabel(effort: SessionEffort | null): string {
  return effort === null ? 'Default' : effort.charAt(0).toUpperCase() + effort.slice(1)
}

export interface ControlsBarState {
  readonly mode: ModeOption
  readonly modelLabel: string
  readonly modelOptions: readonly ModelSelectOption[]
  readonly modelsPending: boolean
  readonly modelsUnavailable: string | null
  readonly effortLabel: string
  readonly effortOptions: readonly SessionEffort[]
}

export function controlsBarState(controls: SessionControls, models: SessionModels): ControlsBarState {
  return {
    mode: { value: controls.permissionMode, label: modeLabel(controls.permissionMode) },
    modelLabel: modelDisplayName(models, controls.model),
    modelOptions: modelOptions(models, controls.model),
    modelsPending: models.kind === 'pending',
    modelsUnavailable: models.kind === 'unavailable' ? models.message : null,
    effortLabel: effortLabel(controls.effort),
    effortOptions: effortOptions(models, controls.model),
  }
}
