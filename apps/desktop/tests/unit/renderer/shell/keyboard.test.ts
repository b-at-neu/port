// `resolveKey`'s Escape rule — closes a list's selection, never a dialog's or an editor's own Esc.
import { describe, expect, it, vi } from 'vitest'
import { resolveKey, runAppCommand } from '@/renderer/shell/keyboard'
import type { KeyboardDeps } from '@/types/shell'

const IDLE = { mod: false, editableFocused: false, dialogOpen: false }

describe('resolveKey Escape', () => {
  it('closes the list selection outside editable focus and dialogs', () => {
    expect(resolveKey('Escape', IDLE)).toEqual({ kind: 'list-close' })
  })

  it('leaves Escape to an editable field', () => {
    expect(resolveKey('Escape', { ...IDLE, editableFocused: true })).toBeNull()
  })

  it('leaves Escape to an open dialog or popper', () => {
    expect(resolveKey('Escape', { ...IDLE, dialogOpen: true })).toBeNull()
  })
})

describe('runAppCommand open-needs-you', () => {
  function deps(): KeyboardDeps {
    return {
      openPalette: vi.fn(),
      openNewSessionDialog: vi.fn(),
      liveSessionKeys: vi.fn(() => []),
      currentSessionKey: vi.fn(() => null),
      selectSession: vi.fn(),
      openNeedsYou: vi.fn(),
      toggleSidebar: vi.fn(),
      startRename: vi.fn(),
      currentListNavigator: vi.fn(() => undefined),
    }
  }

  it('opens Needs you with the notified item selected', () => {
    const d = deps()
    runAppCommand({ kind: 'open-needs-you', focus: 'plan-review:repo-a:552:t' }, d)
    expect(d.openNeedsYou).toHaveBeenCalledWith('plan-review:repo-a:552:t')
    expect(d.selectSession).not.toHaveBeenCalled()
  })

  it('opens Needs you with nothing selected for a collapsed notification', () => {
    const d = deps()
    runAppCommand({ kind: 'open-needs-you', focus: null }, d)
    expect(d.openNeedsYou).toHaveBeenCalledWith(null)
  })

  it('leaves the other commands off Needs you', () => {
    const d = deps()
    runAppCommand({ kind: 'palette' }, d)
    expect(d.openNeedsYou).not.toHaveBeenCalled()
    expect(d.openPalette).toHaveBeenCalledWith('root')
  })
})
