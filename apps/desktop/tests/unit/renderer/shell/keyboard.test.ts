// `resolveKey`'s Escape rule — closes a list's selection, never a dialog's or an editor's own Esc.
import { describe, expect, it } from 'vitest'
import { resolveKey } from '@/renderer/shell/keyboard'

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
