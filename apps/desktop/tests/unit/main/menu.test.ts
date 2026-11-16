import { describe, expect, it, vi } from 'vitest'
import { menuTemplate } from '@/main/menu'
import type { MenuSessionEntry } from '@/main/menu'
import type { SessionKey } from '@/types/hosting'

function labelsOf(submenu: unknown): string[] {
  if (!Array.isArray(submenu)) return []
  return submenu.map((item: { label?: string }) => item.label).filter((label): label is string => typeof label === 'string')
}

function entries(n: number): MenuSessionEntry[] {
  return Array.from({ length: n }, (_, i) => ({ label: `Session ${String(i + 1)}`, sessionKey: `session-${String(i + 1)}` as SessionKey }))
}

describe('menuTemplate', () => {
  it('adds the darwin app menu only on darwin', () => {
    const darwin = menuTemplate('darwin', true, [], vi.fn())
    expect(darwin[0]?.label).toBe('port')

    const linux = menuTemplate('linux', true, [], vi.fn())
    expect(linux[0]?.label).toBe('File')
  })

  it('every command item is display-only (registerAccelerator: false)', () => {
    const template = menuTemplate('linux', true, entries(3), vi.fn())
    for (const topLevel of template) {
      for (const item of (topLevel.submenu as { registerAccelerator?: boolean; click?: unknown }[] | undefined) ?? []) {
        if (item.click !== undefined) expect(item.registerAccelerator).toBe(false)
      }
    }
  })

  it('omits dev-only items when packaged', () => {
    const packaged = menuTemplate('linux', true, [], vi.fn())
    const view = packaged.find((item) => item.label === 'View')
    expect(labelsOf(view?.submenu)).not.toContain('Reload')

    const unpackaged = menuTemplate('linux', false, [], vi.fn())
    const devView = unpackaged.find((item) => item.label === 'View')
    expect((devView?.submenu as { role?: string }[] | undefined)?.some((item) => item.role === 'reload')).toBe(true)
  })

  it('builds a Go to session submenu from the given sessions, each with its titled label and CmdOrCtrl+n', () => {
    const template = menuTemplate('linux', true, entries(3), vi.fn())
    const session = template.find((item) => item.label === 'Session')
    const goTo = (session?.submenu as { label?: string; submenu?: unknown }[] | undefined)?.find((item) => item.label === 'Go to session')
    const items = goTo?.submenu as { label?: string; accelerator?: string }[]
    expect(items.map((item) => item.label)).toEqual(['Session 1', 'Session 2', 'Session 3'])
    expect(items.map((item) => item.accelerator)).toEqual(['CmdOrCtrl+1', 'CmdOrCtrl+2', 'CmdOrCtrl+3'])
  })

  it('caps the Go to session submenu at nine entries', () => {
    const template = menuTemplate('linux', true, entries(12), vi.fn())
    const session = template.find((item) => item.label === 'Session')
    const goTo = (session?.submenu as { label?: string; submenu?: unknown }[] | undefined)?.find((item) => item.label === 'Go to session')
    expect((goTo?.submenu as unknown[]).length).toBe(9)
  })

  it('shows one disabled item when there are no sessions', () => {
    const template = menuTemplate('linux', true, [], vi.fn())
    const session = template.find((item) => item.label === 'Session')
    const goTo = (session?.submenu as { label?: string; submenu?: unknown }[] | undefined)?.find((item) => item.label === 'Go to session')
    const items = goTo?.submenu as { label?: string; enabled?: boolean }[]
    expect(items).toEqual([{ label: 'No sessions open', enabled: false }])
  })

  it('clicking a Go to session item sends open-session with the exact key shown', () => {
    const send = vi.fn()
    const template = menuTemplate('linux', true, entries(2), send)
    const session = template.find((item) => item.label === 'Session')
    const goTo = (session?.submenu as { label?: string; submenu?: unknown }[] | undefined)?.find((item) => item.label === 'Go to session')
    const items = goTo?.submenu as { label?: string; click?: () => void }[]
    items.find((item) => item.label === 'Session 2')?.click?.()
    expect(send).toHaveBeenCalledWith({ kind: 'open-session', sessionKey: 'session-2' })
  })

  it('puts Check for updates after About in the darwin port menu', () => {
    const send = vi.fn()
    const port = menuTemplate('darwin', true, [], send)[0]
    const items = port?.submenu as { role?: string; label?: string; registerAccelerator?: boolean; click?: () => void }[]
    const about = items.findIndex((item) => item.role === 'about')
    expect(items[about + 1]).toMatchObject({ label: 'Check for updates', registerAccelerator: false })
    items[about + 1]?.click?.()
    expect(send).toHaveBeenCalledWith({ kind: 'check-for-updates' })
    expect(menuTemplate('darwin', true, [], send).some((item) => item.label === 'Help')).toBe(false)
  })

  it.each(['linux', 'win32'] as const)('puts Check for updates in a Help menu on %s', (platform) => {
    const send = vi.fn()
    const help = menuTemplate(platform, true, [], send).find((item) => item.label === 'Help')
    const item = (help?.submenu as { label?: string; registerAccelerator?: boolean; click?: () => void }[] | undefined)?.[0]
    expect(item).toMatchObject({ label: 'Check for updates', registerAccelerator: false })
    item?.click?.()
    expect(send).toHaveBeenCalledWith({ kind: 'check-for-updates' })
  })

  it('clicking a command item calls send with its kind', () => {
    const send = vi.fn()
    const template = menuTemplate('linux', true, [], send)
    const file = template.find((item) => item.label === 'File')
    const newSession = (file?.submenu as { label?: string; click?: () => void }[] | undefined)?.find((item) => item.label === 'New session')
    newSession?.click?.()
    expect(send).toHaveBeenCalledWith({ kind: 'new-session' })
  })
})
