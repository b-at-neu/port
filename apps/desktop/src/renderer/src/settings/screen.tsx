// The Settings screen (#316, #367) — the renderer's first React screen,
// proving the router/data/theme path end to end. Four sections: Appearance,
// Claude Code, GitHub CLI, New sessions.
import { ScreenHeader } from '../components/screen-header'
import { ThemeSection } from './theme-section'
import { RuntimeSection } from './runtime-section'
import { GhSection } from './gh-section'
import { SessionDefaultsSection } from './session-defaults-section'

export function SettingsScreen() {
  return (
    <div className="flex h-full flex-col">
      <ScreenHeader>Settings</ScreenHeader>
      <div className="flex max-w-md flex-col gap-6 p-4 text-left">
        <ThemeSection />
        <RuntimeSection />
        <GhSection />
        <SessionDefaultsSection />
      </div>
    </div>
  )
}
