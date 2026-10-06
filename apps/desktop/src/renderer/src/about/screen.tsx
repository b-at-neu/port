// The About screen — static notice copy plus the live `app:info` version line.
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ScreenHeader } from '../components/screen-header'
import { useIpcQuery } from '../data/query'
import { ROUTE_IDS } from '../router/legacy-view'
import { ABOUT_NOTICE, ABOUT_POWERED_BY } from '../../../shared/about/copy'

function VersionLine() {
  const query = useIpcQuery('app:info')
  if (query.status === 'pending') return <Skeleton className="h-4 w-24" />
  if (query.status === 'error') return <p className="font-mono text-small text-muted-foreground">Version unavailable</p>
  return <p className="font-mono text-small text-muted-foreground">Version {query.data.app}</p>
}

export function AboutScreen() {
  const navigate = useNavigate()

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader className="justify-between">
        <span>About</span>
        <Button variant="ghost" size="small" onClick={() => void navigate({ to: ROUTE_IDS.settings })}>
          ‹ Settings
        </Button>
      </ScreenHeader>
      <div className="flex max-w-md flex-col gap-2 p-4 text-left">
        <p className="text-body font-semibold text-foreground">port</p>
        <VersionLine />
        <p data-about-notice className="text-body text-foreground">
          {ABOUT_POWERED_BY}
        </p>
        <p className="text-body text-foreground">{ABOUT_NOTICE}</p>
      </div>
    </div>
  )
}
