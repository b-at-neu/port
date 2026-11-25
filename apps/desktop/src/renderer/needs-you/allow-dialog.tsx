// "Allow from now on" — the denial row's own confirmation, with a rule field main re-validates.
import { useState } from 'react'
import { ConfirmDialog } from '@/renderer/components/confirm-dialog'
import { Input } from '@/renderer/components/ui/input'
import type { RepoId } from '@/utils/repos'
import type { StageDenial } from '@/types/stage'
import { ALLOW_CONFIRM_LABEL, ALLOW_EXPLANATION, ALLOW_RULE_LABEL, ALLOW_TITLE, DISMISS_LABEL } from '@/renderer/needs-you/copy'

export interface AllowTarget {
  readonly repoId: RepoId
  readonly denial: StageDenial
}

interface AllowDialogProps {
  readonly target: AllowTarget
  readonly onAllow: (target: AllowTarget, rule: string) => void
  readonly onDismiss: (target: AllowTarget) => void
  readonly onClose: () => void
}

/** Rendered with `key={denial.id}` so the edited rule resets for each denial. */
export function AllowDialog({ target, onAllow, onDismiss, onClose }: AllowDialogProps) {
  const [rule, setRule] = useState(target.denial.rule)
  return (
    <ConfirmDialog
      open
      title={ALLOW_TITLE}
      description={
        <>
          <p className="text-small text-muted-foreground">{ALLOW_EXPLANATION}</p>
          <Input aria-label={ALLOW_RULE_LABEL} value={rule} onChange={(event) => setRule(event.target.value)} />
        </>
      }
      confirmLabel={ALLOW_CONFIRM_LABEL}
      tone="default"
      secondary={{
        label: DISMISS_LABEL,
        onSelect: () => {
          onClose()
          onDismiss(target)
        },
      }}
      onConfirm={() => {
        onClose()
        onAllow(target, rule)
      }}
      onCancel={onClose}
    />
  )
}
