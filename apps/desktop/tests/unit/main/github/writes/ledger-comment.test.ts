import { describe, expect, it } from 'vitest'
import { writeLedger } from '@/main/github/writes/ledger-comment'
import type { GhResult, GhRunner } from '@/types/platform'
import { createFakeFs, createFakePlatform } from '../../../../support/fake-platform'

function setup(result: GhResult) {
  const fs = createFakeFs()
  const calls: (readonly string[])[] = []
  const written: string[] = []
  const ghWrite: GhRunner = async (args) => {
    calls.push(args)
    const path = args.at(-1)?.replace('body=@', '') ?? ''
    if ((await fs.exists(path)) && (await fs.readText(path)).ok) written.push(path)
    return result
  }
  return { ctx: { ...createFakePlatform(), fs, ghWrite }, fs, calls, written }
}

const params = (ref: number | null) => ({ repo: 'acme/widgets', issue: 52, ref, body: 'ledger', scratchDir: '/scratch' })
const OK: GhResult = { ok: true, stdout: '{}', stderr: '' }

describe('writeLedger', () => {
  it('PATCHes when ref is set and POSTs a new comment otherwise, and removes the scratch file', async () => {
    for (const [ref, head] of [
      [77, ['api', '-X', 'PATCH', 'repos/acme/widgets/issues/comments/77', '-F']],
      [null, ['api', 'repos/acme/widgets/issues/52/comments', '-F']],
    ] as const) {
      const { ctx, fs, calls, written } = setup(OK)
      expect(await writeLedger(ctx, params(ref))).toEqual({ ok: true })
      expect(calls[0]?.slice(0, -1)).toEqual(head)
      expect(written).toHaveLength(1)
      expect(await fs.exists(written[0] ?? '')).toBe(false)
    }
  })

  it('returns the first stderr line on failure, still removing the scratch file', async () => {
    const { ctx, fs, written } = setup({ ok: false, kind: 'forbidden', stdout: '', stderr: 'nope\nmore' })
    expect(await writeLedger(ctx, params(null))).toEqual({ ok: false, error: 'nope' })
    expect(await fs.exists(written[0] ?? '')).toBe(false)
  })
})
