// The one React root (#316) — sidebar, the route `<Outlet/>` portaled into
// `#react-root`, the command palette, the pause dialog, and the toaster.
import { Outlet } from '@tanstack/react-router'
import { createPortal } from 'react-dom'
import { Sidebar } from './sidebar'
import { CommandPalette } from './palette'
import { PauseConfirmDialog } from './pause-confirm'
import { Toaster } from '@/components/ui/sonner'
import { usePortalTarget } from '../react/portal-target'

export function ShellLayout() {
  const reactRoot = usePortalTarget()

  return (
    <>
      <Sidebar />
      {reactRoot !== null ? createPortal(<Outlet />, reactRoot) : null}
      <CommandPalette />
      <PauseConfirmDialog />
      <Toaster />
    </>
  )
}
