// The Settings screen — five sections: Appearance, Claude Code, GitHub CLI,
// New sessions, About.
import { Link } from '@tanstack/react-router'
import { ScreenHeader } from '@/renderer/components/screen-header'
import { Screen, ScreenBody } from '@/renderer/components/screen'
import { ThemeSection } from '@/renderer/settings/theme-section'
import { RuntimeSection } from '@/renderer/settings/runtime-section'
import { GhSection } from '@/renderer/settings/gh-section'
import { SessionDefaultsSection } from '@/renderer/settings/session-defaults-section'
import { ROUTE_IDS } from '@/renderer/router/routes'

function AboutSection() {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-meta font-medium text-muted-foreground">About</h2>
      <Link to={ROUTE_IDS.setup} className="w-fit rounded text-small text-primary-text hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
        Set up port
      </Link>
      <Link to={ROUTE_IDS.about} className="w-fit rounded text-small text-primary-text hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
        About port
      </Link>
    </section>
  )
}

export function SettingsScreen() {
  return (
    <Screen header={<ScreenHeader>Settings</ScreenHeader>}>
      <ScreenBody variant="form">
        <ThemeSection />
        <RuntimeSection />
        <GhSection />
        <SessionDefaultsSection />
        <AboutSection />
      </ScreenBody>
    </Screen>
  )
}
