// Settings → General: theme, notification preferences, keyboard shortcuts.
import { NotificationsSection } from '@/renderer/settings/notifications-section'
import { ShortcutsSection } from '@/renderer/settings/shortcuts-section'
import { ThemeSection } from '@/renderer/settings/theme-section'

export function GeneralTab() {
  return (
    <>
      <ThemeSection />
      <NotificationsSection />
      <ShortcutsSection />
    </>
  )
}
