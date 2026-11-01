// Settings → About: version (with the commit on a dev build), runtime versions, the setup checklist link and notices.
import { Link } from '@tanstack/react-router'
import { Skeleton } from '@/renderer/components/ui/skeleton'
import { SettingsCard } from '@/renderer/components/settings-card'
import { useIpcQuery } from '@/renderer/data/query'
import { ROUTE_IDS } from '@/renderer/router/routes'
import { ABOUT_NOTICE, ABOUT_POWERED_BY } from '@/utils/about/copy'
import { formatAppVersion } from '@/utils/about/version'
import { WIDE_CARD } from '@/renderer/settings/copy'

function VersionLines() {
  const query = useIpcQuery('app:info')
  if (query.status === 'pending') return <Skeleton className="h-4 w-40" />
  if (query.status === 'error') return <p className="font-mono text-small text-muted-foreground">Version unavailable</p>
  const { app, commit, electron, chromium, node } = query.data
  return (
    <>
      <p className="font-mono text-small text-foreground">Version {formatAppVersion(app, commit)}</p>
      <p className="font-mono text-small text-muted-foreground">
        Electron {electron} · Chromium {chromium} · Node {node}
      </p>
    </>
  )
}

export function AboutTab() {
  return (
    <SettingsCard title="About" className={WIDE_CARD}>
      <p className="text-body font-semibold text-foreground">port</p>
      <VersionLines />
      <Link to={ROUTE_IDS.setup} className="w-fit rounded text-small text-primary-text hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
        Open setup checklist
      </Link>
      <p data-about-notice className="text-body text-foreground">
        {ABOUT_POWERED_BY}
      </p>
      <p className="text-body text-foreground">{ABOUT_NOTICE}</p>
    </SettingsCard>
  )
}
