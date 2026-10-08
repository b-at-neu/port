// The one React root — sidebar, the portaled route, the palette, the pause
// dialog, the claim and plan-gate dialogs (mounted once here), the toaster.
import { Outlet } from '@tanstack/react-router'
import { createPortal } from 'react-dom'
import { Sidebar } from './sidebar'
import { CommandPalette } from './palette'
import { PauseConfirmDialog } from './pause-confirm'
import { Toaster } from '@/components/ui/sonner'
import { usePortalTarget } from '../react/portal-target'
import { ClaimDialog } from '../claim/dialog'
import { GateDialog } from '../gate/dialog'

export function ShellLayout() {
  const reactRoot = usePortalTarget()

  return (
    <>
      <Sidebar />
      {reactRoot !== null ? createPortal(<Outlet />, reactRoot) : null}
      <CommandPalette />
      <PauseConfirmDialog />
      <ClaimDialog />
      <GateDialog />
      <Toaster />
    </>
  )
}
