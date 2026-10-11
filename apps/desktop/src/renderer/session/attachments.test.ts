import { describe, expect, it } from 'vitest'
import { checkBatchLimits, classifyFileKind, readAttachment, sizeNotice } from './attachments'
import type { FileLike } from './attachments'
import { MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_PDF_BYTES, MAX_TEXT_BYTES, MAX_TOTAL_BYTES } from '../../../shared/hosting/attachments'

function file(name: string, size: number, type: string): FileLike {
  return { name, size, type }
}

describe('classifyFileKind', () => {
  it('classifies each accepted image media type as image', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      expect(classifyFileKind(file('a', 1, type))).toBe('image')
    }
  })

  it('classifies application/pdf as pdf', () => {
    expect(classifyFileKind(file('a.pdf', 1, 'application/pdf'))).toBe('pdf')
  })

  it('classifies an unlisted image type as unsupported', () => {
    expect(classifyFileKind(file('photo.heic', 1, 'image/heic'))).toBe('unsupported')
  })

  it('classifies anything else as text, to be tried as UTF-8', () => {
    expect(classifyFileKind(file('notes.txt', 1, 'text/plain'))).toBe('text')
    expect(classifyFileKind(file('data.csv', 1, ''))).toBe('text')
  })
})

describe('sizeNotice', () => {
  it('is null under the limit', () => {
    expect(sizeNotice(file('a.png', MAX_IMAGE_BYTES, 'image/png'))).toBeNull()
  })

  it('names the image limit when over it', () => {
    expect(sizeNotice(file('big.png', MAX_IMAGE_BYTES + 1, 'image/png'))).toBe('big.png is over 5 MB.')
  })

  it('names the pdf limit when over it', () => {
    expect(sizeNotice(file('big.pdf', MAX_PDF_BYTES + 1, 'application/pdf'))).toBe('big.pdf is over 10 MB.')
  })

  it('names the text limit when over it', () => {
    expect(sizeNotice(file('big.txt', MAX_TEXT_BYTES + 1, 'text/plain'))).toBe('big.txt is over 256 KB.')
  })
})

describe('checkBatchLimits', () => {
  it('accepts every file under both caps', () => {
    const result = checkBatchLimits(0, 0, [file('a.txt', 10, 'text/plain'), file('b.txt', 10, 'text/plain')])
    expect(result.accepted).toHaveLength(2)
    expect(result.rejected).toHaveLength(0)
  })

  it('rejects past the attachment count cap', () => {
    const files = Array.from({ length: 3 }, (_, i) => file(`f${i}.txt`, 1, 'text/plain'))
    const result = checkBatchLimits(MAX_ATTACHMENTS - 1, 0, files)
    expect(result.accepted).toHaveLength(1)
    expect(result.rejected).toHaveLength(2)
    expect(result.rejected[0]?.notice).toContain('10 attachments')
  })

  it('rejects a file that would push the running total over the cap', () => {
    const result = checkBatchLimits(0, MAX_TOTAL_BYTES - 5, [file('a.txt', 10, 'text/plain')])
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected[0]?.notice).toContain('20 MB')
  })

  it('never drops an accepted file because a later one in the batch was rejected', () => {
    const files = [file('ok.txt', 10, 'text/plain'), file('too-big.txt', MAX_TOTAL_BYTES, 'text/plain')]
    const result = checkBatchLimits(0, 0, files)
    expect(result.accepted.map((f) => f.name)).toEqual(['ok.txt'])
    expect(result.rejected.map((f) => f.file.name)).toEqual(['too-big.txt'])
  })
})

describe('readAttachment', () => {
  it('reads an image to base64 from its data URL', async () => {
    const f = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' })
    const result = await readAttachment(f, { readAsDataUrl: () => Promise.resolve('data:image/png;base64,AQID'), readAsText: () => Promise.resolve('') })
    expect(result).toEqual({ ok: true, attachment: { kind: 'image', name: 'a.png', mediaType: 'image/png', data: 'AQID' } })
  })

  it('rejects an unsupported image type before any read', async () => {
    const f = new File([], 'photo.heic', { type: 'image/heic' })
    const result = await readAttachment(f, { readAsDataUrl: () => Promise.reject(new Error('should not be called')), readAsText: () => Promise.reject(new Error('should not be called')) })
    expect(result).toEqual({ ok: false, notice: "photo.heic isn't supported. Attach an image (PNG, JPEG, GIF, WebP), a PDF, or a text file." })
  })

  it('reads a UTF-8 text file', async () => {
    const f = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    const result = await readAttachment(f, { readAsDataUrl: () => Promise.reject(new Error('n/a')), readAsText: () => Promise.reject(new Error('n/a')) })
    expect(result).toEqual({ ok: true, attachment: { kind: 'text', name: 'notes.txt', text: 'hello' } })
  })

  it('reports unreadable for a file that is not valid UTF-8', async () => {
    const invalidUtf8 = new Uint8Array([0xff, 0xfe, 0xfd])
    const f = new File([invalidUtf8], 'notes.txt', { type: 'text/plain' })
    const result = await readAttachment(f, { readAsDataUrl: () => Promise.reject(new Error('n/a')), readAsText: () => Promise.reject(new Error('n/a')) })
    expect(result).toEqual({ ok: false, notice: "Couldn't read notes.txt." })
  })
})
