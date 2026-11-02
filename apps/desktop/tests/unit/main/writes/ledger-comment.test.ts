import { describe, expect, it } from 'vitest'
import { createLedgerWriter } from '@/main/writes/ledger-comment'
import type { FileResult, GhResult, GhRunner } from '@/types/platform'

const okFile = (): Promise<FileResult<void>> => Promise.resolve({ ok: true, value: undefined })
const PATH = '/scratch/budget-ledger-52-uuid.md'

function writer(result: GhResult, writeResult: Promise<FileResult<void>> = okFile()) {
  const calls: (readonly string[])[] = []
  const written: { path: string; text: string }[] = []
  const removed: string[] = []
  const gh: GhRunner = (args) => {
    calls.push(args)
    return Promise.resolve(result)
  }
  const write = createLedgerWriter({
    gh,
    scratchDir: '/scratch',
    randomUUID: () => 'uuid',
    writeTextFile: (path, text) => {
      written.push({ path, text })
      return writeResult
    },
    removeFile: (path) => {
      removed.push(path)
      return okFile()
    },
  })
  return { write, calls, written, removed }
}

describe('createLedgerWriter', () => {
  it('PATCHes the existing comment, passing the body as a file', async () => {
    const { write, calls, written } = writer({ ok: true, stdout: '{}', stderr: '' })
    expect(await write({ repo: 'acme/widgets', issue: 52, ref: 77, body: 'ledger' })).toEqual({ ok: true })
    expect(calls).toEqual([['api', '-X', 'PATCH', 'repos/acme/widgets/issues/comments/77', '-F', `body=@${PATH}`]])
    expect(written).toEqual([{ path: PATH, text: 'ledger' }])
  })

  it('opens a new comment when there is no existing one', async () => {
    const { write, calls } = writer({ ok: true, stdout: '{}', stderr: '' })
    await write({ repo: 'acme/widgets', issue: 52, ref: null, body: 'ledger' })
    expect(calls).toEqual([['api', 'repos/acme/widgets/issues/52/comments', '-F', `body=@${PATH}`]])
  })

  it('removes the scratch file even when gh fails, and returns the first stderr line', async () => {
    const { write, removed } = writer({ ok: false, kind: 'forbidden', stdout: '', stderr: 'nope\nmore' })
    expect(await write({ repo: 'acme/widgets', issue: 52, ref: null, body: 'ledger' })).toEqual({ ok: false, error: 'nope' })
    expect(removed).toEqual([PATH])
  })

  it('does not call gh when the scratch file cannot be written', async () => {
    const { write, calls } = writer({ ok: true, stdout: '', stderr: '' }, Promise.resolve({ ok: false, kind: 'io', message: 'disk full' }))
    expect(await write({ repo: 'acme/widgets', issue: 52, ref: null, body: 'ledger' })).toEqual({ ok: false, error: 'disk full' })
    expect(calls).toHaveLength(0)
  })
})
