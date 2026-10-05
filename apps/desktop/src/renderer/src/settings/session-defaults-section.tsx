// An operator's default model and permission mode for a new session.
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorBanner } from '../components/error-banner'
import { ipcQueryOptions, useIpcMutation, useIpcQuery } from '../data/query'
import { SESSION_MODELS, SESSION_PERMISSION_MODES } from '../../../shared/hosting/types'
import type { SessionDefaults, SessionModel, SessionPermissionMode } from '../../../shared/hosting/types'

type ModelOption = SessionModel | 'default'

const MODEL_LABEL: Readonly<Record<ModelOption, string>> = {
  default: 'Claude Code default',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
}

const MODE_LABEL: Readonly<Record<SessionPermissionMode, string>> = {
  default: 'Ask before tools',
  acceptEdits: 'Accept edits',
  plan: 'Plan only',
}

const MODE_HELPER: Readonly<Record<SessionPermissionMode, string>> = {
  default: 'Claude asks before any tool that isn’t already allowed.',
  acceptEdits: 'File edits apply without asking. Other tools still ask.',
  plan: 'Claude reads and plans, and changes nothing.',
}

export function SessionDefaultsSection() {
  const query = useIpcQuery('session:defaults')
  const mutation = useIpcMutation('session:defaults:set')
  const client = useQueryClient()

  if (query.status === 'pending') {
    return (
      <section className="flex flex-col gap-3">
        <h2 className="text-meta font-medium text-muted-foreground">New sessions</h2>
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </section>
    )
  }

  if (query.status === 'error') {
    return (
      <section className="flex flex-col gap-3">
        <h2 className="text-meta font-medium text-muted-foreground">New sessions</h2>
        <ErrorBanner message="Couldn't reach the main process to read session defaults. Restart port to try again." />
      </section>
    )
  }

  const defaults = query.data

  async function set(next: SessionDefaults): Promise<void> {
    try {
      const saved = await mutation.mutateAsync(next)
      client.setQueryData(ipcQueryOptions('session:defaults').queryKey, saved)
    } catch {
      toast.error("Couldn't save session defaults.")
      await client.invalidateQueries({ queryKey: ipcQueryOptions('session:defaults').queryKey })
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-meta font-medium text-muted-foreground">New sessions</h2>
      <div className="flex h-9 items-center justify-between">
        <span id="session-model-label" className="text-body text-foreground">
          Model
        </span>
        <Select
          value={defaults.model ?? 'default'}
          disabled={mutation.isPending}
          onValueChange={(value) => void set({ ...defaults, model: value === 'default' ? null : (value as SessionModel) })}
        >
          <SelectTrigger className="w-48" aria-labelledby="session-model-label">
            <SelectValue>{MODEL_LABEL[defaults.model ?? 'default']}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">{MODEL_LABEL.default}</SelectItem>
            {SESSION_MODELS.map((model) => (
              <SelectItem key={model} value={model}>
                {MODEL_LABEL[model]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex h-9 items-center justify-between">
        <span id="session-mode-label" className="text-body text-foreground">
          Permission mode
        </span>
        <Select
          value={defaults.permissionMode}
          disabled={mutation.isPending}
          onValueChange={(value) => void set({ ...defaults, permissionMode: value as SessionPermissionMode })}
        >
          <SelectTrigger className="w-48" aria-labelledby="session-mode-label">
            <SelectValue>{MODE_LABEL[defaults.permissionMode]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {SESSION_PERMISSION_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {MODE_LABEL[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="text-small text-muted-foreground">{MODE_HELPER[defaults.permissionMode]}</p>
      <p className="text-small text-muted-foreground">Applies to sessions you start or restore from now on. Open sessions and pipeline agents keep their own settings.</p>
    </section>
  )
}
