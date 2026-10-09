// The permission dialog — DESIGN §3, an AlertDialog mounted once in
// ShellLayout. Esc (or any other dismiss attempt) denies, never just closes.
import { AlertDialog, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePermissionState, answer, setMessage } from './store'
import { useSelectedSession } from '../session/selection'
import { useIpcQuery } from '../data/query'
import { sessionDisplayLabel, startedClock } from '../../../shared/hosting/label'
import { folderLabel } from '../../../shared/workspace/label'
import type { RepositoryEntry } from '../../../shared/repos'
import {
  ALLOW_ONCE_LABEL,
  ALLOW_SESSION_LABEL,
  blockedPathLine,
  contextLine,
  decisionReasonLine,
  DENY_LABEL,
  DENY_MESSAGE_LABEL,
  DENY_MESSAGE_MAXLENGTH,
  DENY_MESSAGE_PLACEHOLDER,
  formatInput,
  grantSummaryLine,
  headingText,
  INPUT_UNRENDERABLE_MESSAGE,
  OTHER_SESSION_LINE,
  primaryLine,
  SENDING_LABEL,
} from './copy'

const WAIT_TOOLTIP = 'Wait a moment before allowing.'

function repoLabelFor(repos: readonly RepositoryEntry[] | undefined, repoId: string): string {
  const entry = repos?.find((candidate) => candidate.id === repoId)
  if (entry === undefined) return repoId
  return 'config' in entry ? entry.config.repo : entry.displayName
}

export function PermissionDialog() {
  const state = usePermissionState()
  const selectedKey = useSelectedSession()
  const repos = useIpcQuery('repos:list')
  const now = new Date()

  if (state.current === null) return <AlertDialog open={false} />

  const { current, total, message, armed, sending, error } = state
  const { permission } = current
  const busy = sending !== null
  const otherSession = selectedKey !== null && selectedKey !== current.sessionKey
  const repoLabel = current.repoId !== null ? repoLabelFor(repos.data?.ok === true ? repos.data.repositories : undefined, current.repoId) : folderLabel(current.folder)
  const sessionLabel = sessionDisplayLabel({ title: current.title, origin: current.origin }, repoLabel)
  const started = startedClock(current.startedAt, now)
  const formatted = formatInput(permission.input)

  function deny(): void {
    void answer(current, 'deny')
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && deny()}>
      <AlertDialogContent key={permission.permissionId}>
        <AlertDialogHeader>
          {otherSession ? <p className="text-small text-attention-pill-foreground">{OTHER_SESSION_LINE}</p> : null}
          <AlertDialogTitle>{headingText(permission)}</AlertDialogTitle>
          <p className="text-small text-muted-foreground">{contextLine(sessionLabel, started, permission.agentId, 1, total)}</p>
        </AlertDialogHeader>

        {permission.description !== null && permission.description !== '' ? <p className="text-small text-muted-foreground">{permission.description}</p> : null}
        {permission.decisionReason !== null && permission.decisionReason !== '' ? <p className="text-small text-muted-foreground">{decisionReasonLine(permission.decisionReason)}</p> : null}
        {permission.blockedPath !== null && permission.blockedPath !== '' ? <p className="text-small text-muted-foreground">{blockedPathLine(permission.blockedPath)}</p> : null}

        {(() => {
          const primary = primaryLine(permission.toolName, permission.input)
          return primary !== null ? <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-small whitespace-pre-wrap">{primary}</pre> : null
        })()}

        {formatted.ok ? (
          <>
            <span className="text-meta font-medium text-muted-foreground">Full input</span>
            <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-meta whitespace-pre-wrap">{formatted.text}</pre>
            <label className="flex flex-col gap-1">
              <span className="text-meta font-medium text-muted-foreground">{DENY_MESSAGE_LABEL}</span>
              <Textarea
                value={message}
                maxLength={DENY_MESSAGE_MAXLENGTH}
                placeholder={DENY_MESSAGE_PLACEHOLDER}
                onChange={(event) => setMessage(permission.permissionId, event.target.value)}
                rows={2}
              />
            </label>
          </>
        ) : (
          <p role="alert" className="text-small text-danger-pill-foreground">
            {INPUT_UNRENDERABLE_MESSAGE}
          </p>
        )}

        {error !== null ? (
          <p role="alert" className="text-small text-danger-pill-foreground">
            {error}
          </p>
        ) : null}

        <AlertDialogFooter>
          <Button variant="outline" autoFocus disabled={busy} onClick={deny}>
            {sending === 'deny' ? SENDING_LABEL : DENY_LABEL}
          </Button>
          {formatted.ok ? (
            <>
              <AllowButton armed={armed} busy={busy} onClick={() => void answer(current, 'allow-once')} label={sending === 'allow-once' ? SENDING_LABEL : ALLOW_ONCE_LABEL} variant="outline" />
              {permission.sessionGrant !== null ? (
                <div className="flex flex-col gap-1">
                  <AllowButton
                    armed={armed}
                    busy={busy}
                    onClick={() => void answer(current, 'allow-session')}
                    label={sending === 'allow-session' ? SENDING_LABEL : ALLOW_SESSION_LABEL}
                    variant="default"
                  />
                  <p className="text-meta text-muted-foreground">{grantSummaryLine(permission.sessionGrant)}</p>
                </div>
              ) : null}
            </>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function AllowButton({ armed, busy, onClick, label, variant }: { readonly armed: boolean; readonly busy: boolean; readonly onClick: () => void; readonly label: string; readonly variant: 'outline' | 'default' }) {
  const disabled = busy || !armed
  const button = (
    <Button variant={variant} disabled={disabled} onClick={onClick}>
      {label}
    </Button>
  )
  if (armed) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{button}</span>
      </TooltipTrigger>
      <TooltipContent>{WAIT_TOOLTIP}</TooltipContent>
    </Tooltip>
  )
}
