// Settings → Connections: Claude Code, gh, the GitHub rate limit, and each repository's last read, each with a Recheck.
import { Loader2 } from 'lucide-react'
import { Button } from '@/renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { SettingsCard } from '@/renderer/components/settings-card'
import { StatusPill } from '@/renderer/components/status-pill'
import { useIpcMutation } from '@/renderer/data/query'
import { WIDE_CARD } from '@/renderer/settings/copy'
import { GhSection } from '@/renderer/settings/gh-section'
import { RuntimeSection } from '@/renderer/settings/runtime-section'
import { useConnectionOverview } from '@/renderer/settings/use-connection-overview'
import type { PillStatus } from '@/types/components'

const TONE_PILL: Readonly<Record<'success' | 'attention' | 'danger' | 'idle', PillStatus>> = { success: 'success', attention: 'attention', danger: 'danger', idle: 'idle' }

export function ConnectionsTab() {
  const { lines, snapshot } = useConnectionOverview()
  const refresh = useIpcMutation('board:refresh')
  const github = lines.find((line) => line.key === 'github')
  const repositoryLines = lines.filter((line) => line.key.startsWith('repo:'))

  const recheck = (
    <Button variant="outline" size="small" disabled={refresh.isPending} onClick={() => refresh.mutate({ source: 'github' })}>
      {refresh.isPending ? (
        <>
          <Loader2 aria-hidden="true" className="animate-spin" />
          Checking…
        </>
      ) : (
        'Recheck'
      )}
    </Button>
  )

  return (
    <>
      <RuntimeSection />
      <GhSection />
      <SettingsCard title="GitHub API" actions={recheck}>
        {github !== undefined ? <StatusPill status={TONE_PILL[github.tone]} label={github.state} /> : null}
        <p className="text-small text-muted-foreground">One gh login serves every repository, so one rate-limit reading is shared.</p>
      </SettingsCard>
      <SettingsCard title="Repository reads" className={WIDE_CARD} actions={recheck}>
        {repositoryLines.length === 0 ? (
          <p className="text-small text-muted-foreground">No repository has been read yet.</p>
        ) : (
          <div>
            {repositoryLines.map((line) => {
              const lastError = snapshot?.health.find((health) => `repo:${health.repoId}` === line.key)?.github.lastError ?? null
              return (
                <div key={line.key} data-slot="connection-row" className="flex h-9 items-center gap-3 text-body">
                  <span className="min-w-0 flex-1 truncate text-foreground">{line.label}</span>
                  {lastError !== null ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span tabIndex={0} className="max-w-64 truncate rounded text-small text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          {lastError}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{lastError}</TooltipContent>
                    </Tooltip>
                  ) : null}
                  <StatusPill status={TONE_PILL[line.tone]} label={line.state} />
                </div>
              )
            })}
          </div>
        )}
      </SettingsCard>
    </>
  )
}
