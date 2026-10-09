// The controls bar: mode, model, and effort selects, each reverting to the snapshot value on rejection.
import { useState } from 'react'
import { toast } from 'sonner'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { SessionControls, SessionEffort, SessionModels } from '../../../shared/hosting/controls'
import type { SessionKey } from '../../../shared/hosting/types'
import { DEFAULT_SELECT_VALUE, MODE_OPTIONS, controlsBarState, effortLabel } from './controls-model'
import { controlsChangeFailed, MODELS_LOADING } from './interaction-copy'
import { setControls } from './actions'

export interface ControlsBarProps {
  readonly sessionKey: SessionKey
  readonly controls: SessionControls
  readonly models: SessionModels
  readonly disabled: boolean
  readonly disabledReason: string | null
}

export function ControlsBar({ sessionKey, controls, models, disabled, disabledReason }: ControlsBarProps) {
  const [pending, setPending] = useState<'permissionMode' | 'model' | 'effort' | null>(null)
  const state = controlsBarState(controls, models)

  async function apply(patch: { readonly permissionMode?: SessionControls['permissionMode']; readonly model?: string; readonly effort?: SessionEffort | null }, field: 'permissionMode' | 'model' | 'effort'): Promise<void> {
    setPending(field)
    try {
      const result = await setControls(sessionKey, patch)
      if (!result.ok) toast.error(controlsChangeFailed(result.kind === 'rejected' ? result.message : result.kind))
    } finally {
      setPending(null)
    }
  }

  const row = (
    <div className="flex items-center gap-2 text-meta text-muted-foreground">
      <Select value={state.mode.value} disabled={disabled || pending !== null} onValueChange={(value) => void apply({ permissionMode: value as SessionControls['permissionMode'] }, 'permissionMode')}>
        <SelectTrigger className="h-7 w-auto gap-1 border-0 bg-transparent px-1.5 text-meta">
          <SelectValue>{pending === 'permissionMode' ? 'Saving…' : `Mode: ${state.mode.label}`}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {MODE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={controls.model ?? DEFAULT_SELECT_VALUE}
        disabled={disabled || pending !== null || state.modelsPending || state.modelsUnavailable !== null || state.modelOptions.length === 0}
        onValueChange={(value) => { if (value !== DEFAULT_SELECT_VALUE) void apply({ model: value }, 'model') }}
      >
        <SelectTrigger className="h-7 w-auto gap-1 border-0 bg-transparent px-1.5 text-meta">
          <SelectValue>{pending === 'model' ? 'Saving…' : state.modelsPending ? MODELS_LOADING : `Model: ${state.modelLabel}`}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {state.modelOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {state.effortOptions.length > 0 ? (
        <Select
          value={controls.effort ?? DEFAULT_SELECT_VALUE}
          disabled={disabled || pending !== null}
          onValueChange={(value) => void apply({ effort: value === DEFAULT_SELECT_VALUE ? null : (value as SessionEffort) }, 'effort')}
        >
          <SelectTrigger className="h-7 w-auto gap-1 border-0 bg-transparent px-1.5 text-meta">
            <SelectValue>{pending === 'effort' ? 'Saving…' : `Effort: ${effortLabel(controls.effort)}`}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_SELECT_VALUE}>Default</SelectItem>
            {state.effortOptions.map((effort) => (
              <SelectItem key={effort} value={effort}>
                {effortLabel(effort)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  )

  if (!disabled || disabledReason === null) return row

  return (
    <Tooltip>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent>{disabledReason}</TooltipContent>
    </Tooltip>
  )
}
