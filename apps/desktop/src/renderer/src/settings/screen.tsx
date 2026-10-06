// The Settings screen — five sections: Appearance, Claude Code, GitHub CLI,
// New sessions, About.
import { Link } from '@tanstack/react-router'
import { ScreenHeader } from '../components/screen-header'
import { ThemeSection } from './theme-section'
import { RuntimeSection } from './runtime-section'
import { GhSection } from './gh-section'
import { SessionDefaultsSection } from './session-defaults-section'
import { ROUTE_IDS } from '../router/legacy-view'

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
    <div className="flex h-full flex-col">
      <ScreenHeader>Settings</ScreenHeader>
      <div className="flex max-w-md flex-col gap-6 p-4 text-left">
        <ThemeSection />
        <RuntimeSection />
        <GhSection />
        <SessionDefaultsSection />
        <AboutSection />
      </div>
    </div>
  )
}
