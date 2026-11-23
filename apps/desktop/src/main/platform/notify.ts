import { BrowserWindow, Notification } from 'electron'
import type { NativeNotify } from '@/types/platform'

export function focusFirstWindow(): void {
  const [window] = BrowserWindow.getAllWindows()
  if (window === undefined) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

export const nativeNotify: NativeNotify = {
  focused: () => BrowserWindow.getFocusedWindow() !== null,
  show: (notice, onClick) => {
    if (!Notification.isSupported()) return
    const native = new Notification({ title: notice.title, body: notice.body })
    native.on('click', () => {
      focusFirstWindow()
      onClick()
    })
    native.show()
  },
}
