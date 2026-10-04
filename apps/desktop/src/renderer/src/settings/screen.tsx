// The Settings screen (#316) — the renderer's first React screen, proving
// the router/data/theme path end to end. First slice: theme and Claude Code
// status (#318 adds gh status, default model, permission mode and the
// sidebar entry).
import { ScreenHeader } from '../components/screen-header'
import { ThemeSection } from './theme-section'
import { RuntimeSection } from './runtime-section'

export function SettingsScreen() {
  return (
    <div className="flex h-full flex-col">
      <ScreenHeader>Settings</ScreenHeader>
      <div className="flex max-w-md flex-col gap-6 p-4 text-left">
        <ThemeSection />
        <RuntimeSection />
      </div>
    </div>
  )
}
