// The one React root — sidebar, the routed main area, the app-wide dialogs, the toaster.
import { Outlet } from '@tanstack/react-router'
import { Sidebar } from '@/renderer/shell/sidebar'
import { CommandPalette } from '@/renderer/shell/palette'
import { PauseConfirmDialog } from '@/renderer/shell/pause-confirm'
import { TakeOverConfirmDialog } from '@/renderer/shell/take-over-confirm'
import { Toaster } from '@/renderer/components/ui/sonner'
import { ClaimDialog } from '@/renderer/claim/dialog'
import { GateDialog } from '@/renderer/gate/dialog'
import { DecisionDialog } from '@/renderer/decision/dialog'
import { PermissionDialog } from '@/renderer/permission/dialog'
import { NewSessionDialog } from '@/renderer/session/new-session-dialog'
import { AllowDialog } from '@/renderer/needs-you/allow-dialog'
import { RestartDialog } from '@/renderer/needs-you/restart-dialog'

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
