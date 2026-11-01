// The Cut release dialog: pick the version, see what the release will carry, then open the pull requests.
import { useState } from 'react'
import { Button } from '@/renderer/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/renderer/components/ui/dialog'
import { Input } from '@/renderer/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select'
import type { ReleaseStatus } from '@/types/release'
import { normalizeVersion } from '@/utils/release/version'
import { CUSTOM_VERSION_ERROR, CUSTOM_VERSION_LABEL, CUT_RELEASE, OPEN_RELEASE_PR, cutDialogBody, versionOptionLabel } from '@/renderer/releases/copy'

const CUSTOM = 'custom'

interface CutDialogProps {
  readonly status: ReleaseStatus
  readonly pending: boolean
  readonly onCancel: () => void
  readonly onConfirm: (version: string) => void
}

function CutForm({ status, pending, onCancel, onConfirm }: CutDialogProps) {
  const [choice, setChoice] = useState(status.candidates[0]?.version ?? CUSTOM)
  const [custom, setCustom] = useState('')

  const candidate = status.candidates.find((entry) => entry.version === choice)
  const customVersion = normalizeVersion(custom)
  const version = choice === CUSTOM ? customVersion : (candidate?.version ?? null)

  return (
    <>
      <DialogHeader>
        <DialogTitle>{CUT_RELEASE}</DialogTitle>
        <DialogDescription>{cutDialogBody(status)}</DialogDescription>
      </DialogHeader>
      <Select value={choice} onValueChange={setChoice}>
        <SelectTrigger aria-label="Version" className="w-full" data-slot="release-version">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {status.candidates.map((entry) => (
            <SelectItem key={entry.version} value={entry.version}>
              {versionOptionLabel(entry)}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM}>{CUSTOM_VERSION_LABEL}</SelectItem>
        </SelectContent>
      </Select>
      {candidate !== undefined ? <p className="text-small text-muted-foreground">{candidate.reason}</p> : null}
      {choice === CUSTOM ? (
        <div className="flex flex-col gap-1">
          <Input aria-label="Custom version" value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="1.5.0-beta.1" />
          {custom.trim() !== '' && customVersion === null ? <p className="text-small text-danger-pill-foreground">{CUSTOM_VERSION_ERROR}</p> : null}
        </div>
      ) : null}
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button disabled={pending || version === null} onClick={() => version !== null && onConfirm(version)}>
          {OPEN_RELEASE_PR}
        </Button>
      </DialogFooter>
    </>
  )
}

export function CutDialog({ open, ...props }: CutDialogProps & { readonly open: boolean }) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && props.onCancel()}>
      <DialogContent data-slot="cut-dialog">{open ? <CutForm {...props} /> : null}</DialogContent>
    </Dialog>
  )
}
