// The one React root — sidebar, the routed main area, the app-wide dialogs, the toaster.
import { Outlet } from '@tanstack/react-router'
import { Sidebar } from './sidebar'
import { CommandPalette } from './palette'
import { PauseConfirmDialog } from './pause-confirm'
import { TakeOverConfirmDialog } from './take-over-confirm'
import { Toaster } from '@/components/ui/sonner'
import { ClaimDialog } from '../claim/dialog'
import { GateDialog } from '../gate/dialog'
import { DecisionDialog } from '../decision/dialog'
import { PermissionDialog } from '../permission/dialog'
import { NewSessionDialog } from '../session/new-session-dialog'
import { AllowDialog } from '../needs-you/allow-dialog'
import { RestartDialog } from '../needs-you/restart-dialog'

export function ShellLayout() {
  return (
    <>
      <Sidebar />
      <main id="main-area" className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-auto px-8 py-6">
        <Outlet />
      </main>
      <CommandPalette />
      <PauseConfirmDialog />
      <TakeOverConfirmDialog />
      <ClaimDialog />
      <GateDialog />
      <DecisionDialog />
      <PermissionDialog />
      <NewSessionDialog />
      <AllowDialog />
      <RestartDialog />
      <Toaster />
    </>
  )
}
