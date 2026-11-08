// The Cut release dialog: pick the version, see what the release will carry, then open the pull requests.
import { useState } from 'react'
import { Button } from '@/renderer/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/renderer/components/ui/dialog'
import { Input } from '@/renderer/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select'
import type { ReleaseStatus } from '@/types/release'
import { bumpOptions, normalizeVersion } from '@/utils/release/version'
import { CUSTOM_VERSION_ERROR, CUSTOM_VERSION_LABEL, CUT_RELEASE, OPEN_RELEASE_PR, VERSION_PLACEHOLDER, cutDialogBody, versionOptionLabel } from '@/renderer/releases/copy'

const CUSTOM = 'custom'

interface CutDialogProps {
  readonly status: ReleaseStatus
  readonly onCancel: () => void
  readonly onConfirm: (version: string) => void
}

function CutForm({ status, onCancel, onConfirm }: CutDialogProps) {
  const [choice, setChoice] = useState('')
  const [custom, setCustom] = useState('')

  const options = bumpOptions(status.currentVersion ?? '0.0.0')
  const picked = options.find((option) => option.version === choice)
  const customVersion = normalizeVersion(custom)
  const version = choice === CUSTOM ? customVersion : (picked?.version ?? null)

  return (
    <>
      <DialogHeader>
        <DialogTitle>{CUT_RELEASE}</DialogTitle>
        <DialogDescription>{cutDialogBody(status)}</DialogDescription>
      </DialogHeader>
      <Select value={choice} onValueChange={setChoice}>
        <SelectTrigger aria-label="Version" className="w-full" data-slot="release-version">
          <SelectValue placeholder={VERSION_PLACEHOLDER} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.version} value={option.version}>
              {versionOptionLabel(option)}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM}>{CUSTOM_VERSION_LABEL}</SelectItem>
        </SelectContent>
      </Select>
      {choice === CUSTOM ? (
        <div className="flex flex-col gap-1">
          <Input aria-label="Custom version" value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="1.5.0-beta.1" />
          {custom.trim() !== '' && customVersion === null ? <p className="text-small text-danger-pill-foreground">{CUSTOM_VERSION_ERROR}</p> : null}
        </div>
      ) : null}
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={version === null}
          onClick={() => {
            if (version === null) return
            onCancel()
            onConfirm(version)
          }}
        >
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
