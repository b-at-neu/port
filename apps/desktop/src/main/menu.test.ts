import { describe, expect, it, vi } from 'vitest'
import { menuTemplate } from './menu'

function labelsOf(submenu: unknown): string[] {
  if (!Array.isArray(submenu)) return []
  return submenu.map((item: { label?: string }) => item.label).filter((label): label is string => typeof label === 'string')
}

describe('menuTemplate', () => {
  it('adds the darwin app menu only on darwin', () => {
    const darwin = menuTemplate('darwin', true, vi.fn())
    expect(darwin[0]?.label).toBe('port')

    const linux = menuTemplate('linux', true, vi.fn())
    expect(linux[0]?.label).toBe('File')
  })

  it('every command item is display-only (registerAccelerator: false)', () => {
    const template = menuTemplate('linux', true, vi.fn())
    for (const topLevel of template) {
      for (const item of (topLevel.submenu as { registerAccelerator?: boolean; click?: unknown }[] | undefined) ?? []) {
        if (item.click !== undefined) expect(item.registerAccelerator).toBe(false)
      }
    }
  })

  it('omits dev-only items when packaged', () => {
    const packaged = menuTemplate('linux', true, vi.fn())
    const view = packaged.find((item) => item.label === 'View')
    expect(labelsOf(view?.submenu)).not.toContain('Reload')

    const unpackaged = menuTemplate('linux', false, vi.fn())
    const devView = unpackaged.find((item) => item.label === 'View')
    expect((devView?.submenu as { role?: string }[] | undefined)?.some((item) => item.role === 'reload')).toBe(true)
  })

  it('builds a Go to session submenu with nine entries', () => {
    const template = menuTemplate('linux', true, vi.fn())
    const session = template.find((item) => item.label === 'Session')
    const goTo = (session?.submenu as { label?: string; submenu?: unknown }[] | undefined)?.find((item) => item.label === 'Go to session')
    expect(Array.isArray(goTo?.submenu)).toBe(true)
    expect((goTo?.submenu as unknown[]).length).toBe(9)
  })

  it('clicking a command item calls send with its kind', () => {
    const send = vi.fn()
    const template = menuTemplate('linux', true, send)
    const file = template.find((item) => item.label === 'File')
    const newSession = (file?.submenu as { label?: string; click?: () => void }[] | undefined)?.find((item) => item.label === 'New session')
    newSession?.click?.()
    expect(send).toHaveBeenCalledWith({ kind: 'new-session' })
  })
})
