// DESIGN §4: a dialog asks one question; its buttons are the answers and the X means cancel.
import type { ReactNode } from 'react'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/renderer/components/ui/alert-dialog'
import { Button } from '@/renderer/components/ui/button'

export interface ConfirmSpec {
  readonly title: string
  readonly description?: ReactNode
  readonly confirmLabel: string
  readonly cancelLabel?: string
  readonly tone?: 'default' | 'destructive'
}

interface ConfirmDialogProps extends ConfirmSpec {
  readonly open: boolean
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

export function ConfirmDialog({ open, title, description, confirmLabel, cancelLabel = 'Cancel', tone = 'destructive', onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent {...(description === undefined ? { 'aria-describedby': undefined } : {})}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {typeof description === 'string' ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
          {description !== undefined && typeof description !== 'string' ? (
            <AlertDialogDescription asChild>
              <div>{description}</div>
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <Button variant={tone === 'destructive' ? 'destructive' : 'default'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
