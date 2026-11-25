// The permission dialog — DESIGN §3, an AlertDialog mounted once in
// ShellLayout. Esc (or any other dismiss attempt) denies, never just closes.
import { useCallback, useState } from 'react'
import { AlertDialog, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/renderer/components/ui/alert-dialog'
import { Button } from '@/renderer/components/ui/button'
import { Textarea } from '@/renderer/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { useAnswerPermission } from '@/renderer/actions/answer-permission'
import { pendingPermissionsOf } from '@/renderer/permission/queue'
import { useSelectedSessionKey } from '@/renderer/app/session-key'
import { useIpcQuery } from '@/renderer/data/query'
import { formatClock } from '@/renderer/lib/time'
import { sessionDisplayLabel } from '@/utils/hosting/label'
import { folderLabel } from '@/utils/workspace/label'
import type { QueuedPermission } from '@/types/permission'
import type { RepositoryEntry } from '@/utils/repos'
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
  IPC_FAILURE_MESSAGE,
  OTHER_SESSION_LINE,
  primaryLine,
  protectedPathLine,
  SENDING_LABEL,
} from '@/renderer/permission/copy'

const WAIT_TOOLTIP = 'Wait a moment before allowing.'
const ARM_DELAY_MS = 600

function repoLabelFor(repos: readonly RepositoryEntry[] | undefined, repoId: string): string {
  const entry = repos?.find((candidate) => candidate.id === repoId)
  if (entry === undefined) return repoId
  return 'config' in entry ? entry.config.repo : entry.displayName
}

export function PermissionDialog() {
  const sessions = useIpcQuery('session.list')
  const selectedKey = useSelectedSessionKey()
  const repos = useIpcQuery('repos.list')
  const { items } = pendingPermissionsOf(sessions.data ?? [])
  const current = items[0]

  if (current === undefined) return <AlertDialog open={false} />

  const repoLabel = current.repoId !== null ? repoLabelFor(repos.data?.ok === true ? repos.data.repositories : undefined, current.repoId) : folderLabel(current.folder)
  return (
    <AlertDialog open>
      <PermissionPrompt key={current.permission.permissionId} item={current} total={items.length} otherSession={selectedKey !== null && selectedKey !== current.sessionKey} repoLabel={repoLabel} />
    </AlertDialog>
  )
}

interface PermissionPromptProps {
  readonly item: QueuedPermission
  readonly total: number
  readonly otherSession: boolean
  readonly repoLabel: string
}

function PermissionPrompt({ item, total, otherSession, repoLabel }: PermissionPromptProps) {
  const { permission } = item
  const [message, setMessage] = useState('')
  const [armed, setArmed] = useState(false)
  const { answer, sending, failed } = useAnswerPermission()
  const armRef = useCallback((node: HTMLDivElement | null) => {
    if (node === null) return
    const timer = setTimeout(() => setArmed(true), ARM_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])
  const busy = sending !== null
  const sessionLabel = sessionDisplayLabel({ title: item.title, origin: item.origin }, repoLabel)
  const started = formatClock(item.startedAt, new Date())
  const formatted = formatInput(permission.input)
  const primary = primaryLine(permission.toolName, permission.input)

  function deny(): void {
    void answer(item, 'deny', message)
  }

  return (
    <AlertDialogContent
      ref={armRef}
      showCloseButton={false}
      onEscapeKeyDown={(event) => {
        event.preventDefault()
        deny()
      }}
    >
      <AlertDialogHeader>
        {otherSession ? <p className="text-small text-attention-pill-foreground">{OTHER_SESSION_LINE}</p> : null}
        {permission.protectedPath !== null ? <p className="text-small font-medium">{protectedPathLine(permission.protectedPath)}</p> : null}
        <AlertDialogTitle>{headingText(permission)}</AlertDialogTitle>
        <p className="text-small text-muted-foreground">{contextLine(sessionLabel, started, permission.agentId, 1, total)}</p>
      </AlertDialogHeader>

      {permission.description !== null && permission.description !== '' ? <p className="text-small text-muted-foreground">{permission.description}</p> : null}
      {permission.decisionReason !== null && permission.decisionReason !== '' ? <p className="text-small text-muted-foreground">{decisionReasonLine(permission.decisionReason)}</p> : null}
      {permission.blockedPath !== null && permission.blockedPath !== '' ? <p className="text-small text-muted-foreground">{blockedPathLine(permission.blockedPath)}</p> : null}

      {primary !== null ? <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-small whitespace-pre-wrap">{primary}</pre> : null}

      {formatted.ok ? (
        <>
          <span className="text-meta font-medium text-muted-foreground">Full input</span>
          <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-meta whitespace-pre-wrap">{formatted.text}</pre>
          <label className="flex flex-col gap-1">
            <span className="text-meta font-medium text-muted-foreground">{DENY_MESSAGE_LABEL}</span>
            <Textarea value={message} maxLength={DENY_MESSAGE_MAXLENGTH} placeholder={DENY_MESSAGE_PLACEHOLDER} onChange={(event) => setMessage(event.target.value)} rows={2} />
          </label>
        </>
      ) : (
        <p role="alert" className="text-small text-danger-pill-foreground">
          {INPUT_UNRENDERABLE_MESSAGE}
        </p>
      )}

      {failed ? (
        <p role="alert" className="text-small text-danger-pill-foreground">
          {IPC_FAILURE_MESSAGE}
        </p>
      ) : null}

      <AlertDialogFooter>
        <Button variant="outline" autoFocus disabled={busy} onClick={deny}>
          {sending === 'deny' ? SENDING_LABEL : DENY_LABEL}
        </Button>
        {formatted.ok ? (
          <>
            <AllowButton armed={armed} busy={busy} onClick={() => void answer(item, 'allow-once', message)} label={sending === 'allow-once' ? SENDING_LABEL : ALLOW_ONCE_LABEL} variant="outline" />
            {permission.sessionGrant !== null ? (
              <div className="flex flex-col gap-1">
                <AllowButton armed={armed} busy={busy} onClick={() => void answer(item, 'allow-session', message)} label={sending === 'allow-session' ? SENDING_LABEL : ALLOW_SESSION_LABEL} variant="default" />
                <p className="text-meta text-muted-foreground">{grantSummaryLine(permission.sessionGrant)}</p>
              </div>
            ) : null}
          </>
        ) : null}
      </AlertDialogFooter>
    </AlertDialogContent>
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
