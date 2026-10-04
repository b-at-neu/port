// Settings' Appearance section (#316) — the theme row, the one control
// this ticket needs so Light/Dark/System can actually be switched. No
// `useEffect`: `useThemePreference` reads the store through
// `useSyncExternalStore`.
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useThemePreference } from '../theme/store'
import type { ThemePreference } from '../theme/store'

const LABEL: Readonly<Record<ThemePreference, string>> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
}

export function ThemeSection() {
  const [preference, setPreference] = useThemePreference()

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-meta font-medium text-muted-foreground">Appearance</h2>
      <div className="flex h-9 items-center justify-between">
        <span className="text-body text-foreground">Theme</span>
        <Select value={preference} onValueChange={(value) => setPreference(value as ThemePreference)}>
          <SelectTrigger className="w-32">
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
    </section>
  )
}
