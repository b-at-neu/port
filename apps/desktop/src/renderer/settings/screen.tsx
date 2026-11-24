// The Settings screen — a full-width, tabbed grid of cards. Only the active tab mounts, so a
// tab's queries do not run until it opens.
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Page } from '@/renderer/components/page'
import { ScreenHeader } from '@/renderer/components/screen-header'
import { Tabs, TabsList, TabsTrigger } from '@/renderer/components/ui/tabs'
import { ROUTE_IDS } from '@/renderer/app/routes'
import { SETTINGS_SECTIONS } from '@/types/router'
import type { SettingsSection } from '@/types/router'
import { SECTION_LABEL, SETTINGS_GRID, SETTINGS_TITLE } from '@/renderer/settings/copy'
import { GeneralTab } from '@/renderer/settings/general-tab'
import { RepositoriesTab } from '@/renderer/repositories/list-tab'
import { ConnectionsTab } from '@/renderer/settings/connections-tab'
import { PipelineTab } from '@/renderer/settings/pipeline-tab'
import { UsageTab } from '@/renderer/settings/usage-tab'
import { AuditTab } from '@/renderer/audit/tab'
import { IncidentsTab } from '@/renderer/incidents/tab'
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
    case 'audit':
      return <AuditTab />
    case 'incidents':
      return <IncidentsTab />
    case 'about':
      return <AboutTab />
  }
}

export function SettingsScreen() {
  const search = useSearch({ from: ROUTE_IDS.settings })
  const navigate = useNavigate()
  const section = search.section ?? 'general'

  return (
    <Page
      variant="page"
      header={
        <>
          <ScreenHeader>{SETTINGS_TITLE}</ScreenHeader>
          <Tabs value={section} onValueChange={(value) => void navigate({ to: ROUTE_IDS.settings, search: { section: value as SettingsSection }, replace: true })} className="pb-2">
            <TabsList className="mx-4 mt-2 self-start">
              {SETTINGS_SECTIONS.map((id) => (
                <TabsTrigger key={id} value={id}>
                  {SECTION_LABEL[id]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </>
      }
    >
      <div className={SETTINGS_GRID}>
        <TabBody section={section} />
      </div>
    </Page>
  )
}
