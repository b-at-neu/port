import { describe, expect, it } from 'vitest'
import { buildUserContent } from './content'
import type { ComposerAttachment } from '../../shared/hosting/attachments'

describe('buildUserContent', () => {
  it('passes a string through untouched when there are no attachments', () => {
    expect(buildUserContent('hello', [])).toBe('hello')
  })

  it('builds an image block', () => {
    const attachment: ComposerAttachment = { kind: 'image', name: 'a.png', mediaType: 'image/png', data: 'QUJD' }
    expect(buildUserContent('', [attachment])).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }])
  })

  it('builds a pdf block', () => {
    const attachment: ComposerAttachment = { kind: 'pdf', name: 'doc.pdf', data: 'QUJD' }
    expect(buildUserContent('', [attachment])).toEqual([{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'QUJD' }, title: 'doc.pdf' }])
  })

  it('builds a text document block', () => {
    const attachment: ComposerAttachment = { kind: 'text', name: 'notes.txt', text: 'hi' }
    expect(buildUserContent('', [attachment])).toEqual([{ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'hi' }, title: 'notes.txt' }])
  })

  it('appends the text block last, after every attachment block', () => {
    const attachment: ComposerAttachment = { kind: 'text', name: 'notes.txt', text: 'hi' }
    const result = buildUserContent('describe this', [attachment])
    expect(Array.isArray(result)).toBe(true)
    if (!Array.isArray(result)) return
    expect(result).toHaveLength(2)
    expect(result[1]).toEqual({ type: 'text', text: 'describe this' })
  })

  it('omits the text block entirely when text is empty', () => {
    const attachment: ComposerAttachment = { kind: 'text', name: 'notes.txt', text: 'hi' }
    const result = buildUserContent('', [attachment])
    expect(Array.isArray(result)).toBe(true)
    if (!Array.isArray(result)) return
    expect(result).toHaveLength(1)
  })
})
