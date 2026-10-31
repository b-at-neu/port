import { describe, expect, it } from 'vitest'
import { ARCHIVE_CONFIRM_ACTION, ARCHIVE_CONFIRM_PROMPT, markFailureToast, markSuccessToast, menuItemLabel } from '@/renderer/session/marks-copy'

describe('menuItemLabel', () => {
  it('flips the verb on the current mark', () => {
    expect(menuItemLabel('pinned', false)).toBe('Pin')
    expect(menuItemLabel('pinned', true)).toBe('Unpin')
    expect(menuItemLabel('archived', false)).toBe('Archive')
    expect(menuItemLabel('archived', true)).toBe('Unarchive')
  })
})

describe('markSuccessToast', () => {
  it('names the mark and, for archive, that History hides it', () => {
    expect(markSuccessToast('pinned', true)).toBe('Pinned.')
    expect(markSuccessToast('pinned', false)).toBe('Unpinned.')
    expect(markSuccessToast('archived', true)).toBe("Archived. It's hidden from History.")
    expect(markSuccessToast('archived', false)).toBe('Unarchived.')
  })

  it('says the session was closed only when archiving closed one', () => {
    expect(markSuccessToast('archived', true, true)).toBe("Archived and closed. It's hidden from History.")
    expect(markSuccessToast('archived', false, true)).toBe('Unarchived.')
    expect(markSuccessToast('pinned', true, true)).toBe('Pinned.')
  })

  it('pins the archive confirm copy', () => {
    expect(ARCHIVE_CONFIRM_PROMPT).toBe('Archive while Claude is working? The current turn is abandoned.')
    expect(ARCHIVE_CONFIRM_ACTION).toBe('Archive session')
  })
})

describe('markFailureToast', () => {
  it('names the verb and distinguishes an invalid id from an unreachable main process', () => {
    expect(markFailureToast('pinned', { ok: false, kind: 'invalid-session-id' })).toBe("Couldn't pin the session: its id isn't valid.")
    expect(markFailureToast('archived', 'unreachable')).toBe("Couldn't archive the session: couldn't reach the main process.")
  })
})
