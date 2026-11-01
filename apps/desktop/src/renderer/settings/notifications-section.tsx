// Two switches over `notify:prefs` — which OS notifications port may show while its window is unfocused.
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { Switch } from '@/renderer/components/ui/switch'
import { ErrorBanner } from '@/renderer/components/error-banner'
import { SettingsCard } from '@/renderer/components/settings-card'
import { ipcQueryOptions, useIpcMutation, useIpcQuery } from '@/renderer/data/query'
import { cardReadError } from '@/renderer/settings/copy'
import type { NotificationPrefs } from '@/types/settings'

const ROWS: readonly { readonly key: keyof NotificationPrefs; readonly label: string }[] = [
  { key: 'needsYou', label: 'When something needs you' },
  { key: 'sessions', label: 'When your own sessions finish or need permission' },
]

export function NotificationsSection() {
  const query = useIpcQuery('notify:prefs')
  const mutation = useIpcMutation('notify:prefs:set')
  const client = useQueryClient()

  if (query.status === 'pending') {
    return (
      <SettingsCard title="Notifications">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
      </SettingsCard>
    )
  }

  if (query.status === 'error') {
    return (
      <SettingsCard title="Notifications">
        <ErrorBanner message={cardReadError('notification preferences')} />
      </SettingsCard>
    )
  }

  const prefs = query.data

  async function set(next: NotificationPrefs): Promise<void> {
    try {
      const saved = await mutation.mutateAsync(next)
      client.setQueryData(ipcQueryOptions('notify:prefs').queryKey, saved)
    } catch {
      toast.error("Couldn't save notification preferences.")
      await client.invalidateQueries({ queryKey: ipcQueryOptions('notify:prefs').queryKey })
    }
  }

  return (
    <SettingsCard title="Notifications" description="Shown only while no port window is focused.">
      {ROWS.map(({ key, label }) => (
        <div key={key} className="flex min-h-9 items-center justify-between gap-3">
          <span id={`notify-${key}-label`} className="text-body text-foreground">
            {label}
          </span>
          <Switch aria-labelledby={`notify-${key}-label`} checked={prefs[key]} disabled={mutation.isPending} onCheckedChange={(checked) => void set({ ...prefs, [key]: checked })} />
        </div>
      ))}
    </SettingsCard>
  )
}
