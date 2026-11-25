// The one React root — sidebar, the routed main area, the app-wide dialogs, the toaster.
import { Outlet } from '@tanstack/react-router'
import { Sidebar } from '@/renderer/app/sidebar'
import { CommandPalette } from '@/renderer/app/palette'
import { Toaster } from '@/renderer/components/ui/sonner'
import { GateDialog } from '@/renderer/gate/dialog'
import { DecisionDialog } from '@/renderer/decision/dialog'
import { PermissionDialog } from '@/renderer/permission/dialog'
import { NewSessionDialog } from '@/renderer/session/new-session-dialog'

export function ShellLayout() {
  return (
    <>
      <Sidebar />
      <main id="main-area" className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
        <Outlet />
      </main>
      <CommandPalette />
      <GateDialog />
      <DecisionDialog />
      <PermissionDialog />
      <NewSessionDialog />
      <Toaster />
    </>
  )
}
