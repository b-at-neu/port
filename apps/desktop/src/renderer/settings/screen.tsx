// The Settings screen — a full-width, tabbed grid of cards. Only the active tab mounts, so a
// tab's queries do not run until it opens.
import { useNavigate, useSearch } from '@tanstack/react-router'
import { ScreenHeader } from '@/renderer/components/screen-header'
import { Screen, ScreenBody } from '@/renderer/components/screen'
import { Tabs, TabsList, TabsTrigger } from '@/renderer/components/ui/tabs'
import { ROUTE_IDS } from '@/renderer/router/routes'
import { SETTINGS_SECTIONS } from '@/types/router'
import type { SettingsSection } from '@/types/router'
import { SECTION_LABEL, SETTINGS_GRID } from '@/renderer/settings/copy'
import { GeneralTab } from '@/renderer/settings/general-tab'
import { RepositoriesTab } from '@/renderer/repositories/list-tab'
import { ConnectionsTab } from '@/renderer/settings/connections-tab'
import { PipelineTab } from '@/renderer/settings/pipeline-tab'
import { UsageTab } from '@/renderer/settings/usage-tab'
import { AboutTab } from '@/renderer/settings/about-tab'

function TabBody({ section }: { readonly section: SettingsSection }) {
  switch (section) {
    case 'general':
      return <GeneralTab />
    case 'repositories':
      return <RepositoriesTab />
    case 'connections':
      return <ConnectionsTab />
    case 'pipeline':
      return <PipelineTab />
    case 'usage':
      return <UsageTab />
    case 'about':
      return <AboutTab />
  }
}

export function SettingsScreen() {
  const search = useSearch({ from: ROUTE_IDS.settings })
  const navigate = useNavigate()
  const section = search.section ?? 'general'

  return (
    <Screen header={<ScreenHeader>Settings</ScreenHeader>}>
      <Tabs
        value={section}
        onValueChange={(value) => void navigate({ to: ROUTE_IDS.settings, search: { section: value as SettingsSection }, replace: true })}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <TabsList className="mx-4 mt-2 self-start">
          {SETTINGS_SECTIONS.map((id) => (
            <TabsTrigger key={id} value={id}>
              {SECTION_LABEL[id]}
            </TabsTrigger>
          ))}
        </TabsList>
        <ScreenBody variant="page">
          <div className={SETTINGS_GRID}>
            <TabBody section={section} />
          </div>
        </ScreenBody>
      </Tabs>
    </Screen>
  )
}
