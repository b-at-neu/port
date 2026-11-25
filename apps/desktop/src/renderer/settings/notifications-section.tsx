// Two switches over `notify:prefs` — which OS notifications port may show while its window is unfocused.
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { Switch } from '@/renderer/components/ui/switch'
import { useActionMutation } from '@/renderer/actions/use-action-mutation'
import { useIpcQuery } from '@/renderer/data/query'
import { cardReadError, NOTIFICATION_ROWS, NOTIFICATIONS_DESCRIPTION, NOTIFICATIONS_SUBJECT, NOTIFICATIONS_TITLE } from '@/renderer/settings/copy'
import { QueryCard } from '@/renderer/settings/query-card'
import type { NotificationPrefs } from '@/types/settings'

const KEYS = ['needsYou', 'sessions'] as const satisfies readonly (keyof NotificationPrefs)[]

export function NotificationsSection() {
  const query = useIpcQuery('notify.prefs')
  const save = useActionMutation('notify.prefsSet', { invalidates: ['notify.prefs'] })

  return (
    <QueryCard
      title={NOTIFICATIONS_TITLE}
      description={NOTIFICATIONS_DESCRIPTION}
      query={query}
      errorMessage={cardReadError(NOTIFICATIONS_SUBJECT)}
      loading={
        <>
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </>
      }
    >
      {(prefs) =>
        KEYS.map((key) => (
          <div key={key} className="flex min-h-9 items-center justify-between gap-3">
            <span id={`notify-${key}-label`} className="text-body text-foreground">
              {NOTIFICATION_ROWS[key]}
            </span>
            <Switch aria-labelledby={`notify-${key}-label`} checked={prefs[key]} disabled={save.pending} onCheckedChange={(checked) => void save.perform({ ...prefs, [key]: checked })} />
          </div>
        ))
      }
    </QueryCard>
  )
}
