// Settings' Appearance card — the theme row. No `useEffect`: `useThemePreference`
// reads the store through `useSyncExternalStore`.
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select'
import { SettingsCard } from '@/renderer/components/settings-card'
import { useThemePreference } from '@/renderer/theme/store'
import type { ThemePreference } from '@/types/theme'

const LABEL: Readonly<Record<ThemePreference, string>> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
}

export function ThemeSection() {
  const [preference, setPreference] = useThemePreference()

  return (
    <SettingsCard title="Appearance">
      <div className="flex h-9 items-center justify-between">
        <span id="theme-select-label" className="text-body text-foreground">
          Theme
        </span>
        <Select value={preference} onValueChange={(value) => setPreference(value as ThemePreference)}>
          <SelectTrigger className="w-32" aria-labelledby="theme-select-label">
            <SelectValue>{LABEL[preference]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">{LABEL.system}</SelectItem>
            <SelectItem value="light">{LABEL.light}</SelectItem>
            <SelectItem value="dark">{LABEL.dark}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-small text-muted-foreground">System follows your operating system&rsquo;s light or dark setting.</p>
    </SettingsCard>
  )
}
