// An operator's default model and permission mode for a new session.
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { useActionMutation } from '@/renderer/actions/use-action-mutation'
import { useIpcQuery } from '@/renderer/data/query'
import { cardReadError, MODE_HELPER, MODE_LABEL, MODE_ROW_LABEL, MODEL_LABEL, MODEL_ROW_LABEL, NEW_SESSIONS_NOTE, NEW_SESSIONS_SUBJECT, NEW_SESSIONS_TITLE } from '@/renderer/settings/copy'
import { QueryCard } from '@/renderer/settings/query-card'
import { SESSION_MODELS, SESSION_PERMISSION_MODES } from '@/types/hosting'
import type { SessionModel, SessionPermissionMode } from '@/types/hosting'

export function SessionDefaultsSection() {
  const query = useIpcQuery('session.defaults')
  const save = useActionMutation('session.defaultsSet', { invalidates: ['session.defaults'] })

  return (
    <QueryCard
      title={NEW_SESSIONS_TITLE}
      query={query}
      errorMessage={cardReadError(NEW_SESSIONS_SUBJECT)}
      loading={
        <>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </>
      }
    >
      {(defaults) => (
        <>
          <div className="flex h-9 items-center justify-between">
            <span id="session-model-label" className="text-body text-foreground">
              {MODEL_ROW_LABEL}
            </span>
            <Select value={defaults.model ?? 'default'} disabled={save.pending} onValueChange={(value) => void save.perform({ ...defaults, model: value === 'default' ? null : (value as SessionModel) })}>
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
              {MODE_ROW_LABEL}
            </span>
            <Select value={defaults.permissionMode} disabled={save.pending} onValueChange={(value) => void save.perform({ ...defaults, permissionMode: value as SessionPermissionMode })}>
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
          <p className="text-small text-muted-foreground">{NEW_SESSIONS_NOTE}</p>
        </>
      )}
    </QueryCard>
  )
}
