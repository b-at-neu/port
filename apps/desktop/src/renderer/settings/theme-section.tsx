// Settings' Appearance card — the theme row.
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select'
import { SettingsCard } from '@/renderer/components/settings-card'
import { APPEARANCE_TITLE, THEME_HELPER, THEME_LABEL, THEME_ROW_LABEL } from '@/renderer/settings/copy'
import { useThemePreference } from '@/renderer/app/theme'
import type { ThemePreference } from '@/types/theme'

export function ThemeSection() {
  const [preference, setPreference] = useThemePreference()

  return (
    <SettingsCard title={APPEARANCE_TITLE}>
      <div className="flex h-9 items-center justify-between">
        <span id="theme-select-label" className="text-body text-foreground">
          {THEME_ROW_LABEL}
        </span>
        <Select value={preference} onValueChange={(value) => setPreference(value as ThemePreference)}>
          <SelectTrigger className="w-32" aria-labelledby="theme-select-label">
            <SelectValue>{THEME_LABEL[preference]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">{THEME_LABEL.system}</SelectItem>
            <SelectItem value="light">{THEME_LABEL.light}</SelectItem>
            <SelectItem value="dark">{THEME_LABEL.dark}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-small text-muted-foreground">{THEME_HELPER}</p>
    </SettingsCard>
  )
}
