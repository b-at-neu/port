import { describe, expect, it } from 'vitest'
import { HISTORY_LIMIT, readHistory } from '@/main/sessions/hosting/history'
import { pathOps } from '@/main/platform/paths'
import type { SessionStartMode } from '@/types/hosting'
import { createFakeFs } from '../../../support/fake-platform'

const SESSION_ID = '3f2a9c10-1b2c-4d3e-8f4a-5b6c7d8e9f01'
const CLAUDE_HOME = '/test/claude'

// A user record per uuid; the deriver turns each into one entry.
const record = (uuid: string): string => JSON.stringify({ type: 'user', uuid, timestamp: '2024-01-01T00:00:00.000Z', message: { role: 'user', content: uuid } })

async function ctxWith(uuids: readonly string[] | null) {
  const fs = createFakeFs()
  if (uuids !== null) await fs.writeText(pathOps.join(CLAUDE_HOME, 'projects', 'p1', `${SESSION_ID}.jsonl`), `${uuids.map(record).join('\n')}\n`)
  return { fs, claudeHome: CLAUDE_HOME }
}

const uuidsOf = (entries: readonly { readonly uuid?: string }[]): (string | undefined)[] => entries.map((entry) => entry.uuid)

describe('readHistory', () => {
  const resume: SessionStartMode = { kind: 'resume', sessionId: SESSION_ID }

  it.each<{ readonly name: string; readonly mode: SessionStartMode; readonly uuids: readonly string[] | null; readonly expected: unknown }>([
    { name: 'reads nothing for a fresh session', mode: { kind: 'fresh' }, uuids: null, expected: { kind: 'none' } },
    { name: 'loads the whole transcript for resume', mode: resume, uuids: ['a', 'b'], expected: { kind: 'loaded', uuids: ['a', 'b'], omittedBefore: 0 } },
    {
      name: 'cuts after the resume point for resume-at',
      mode: { kind: 'resume-at', sessionId: SESSION_ID, messageUuid: 'b', resumeDropsTurn: null },
      uuids: ['a', 'b', 'c'],
      expected: { kind: 'loaded', uuids: ['a', 'b'], omittedBefore: 0 },
    },
    {
      name: 'fails when the resume point is not in the transcript',
      mode: { kind: 'resume-at', sessionId: SESSION_ID, messageUuid: 'missing', resumeDropsTurn: null },
      uuids: ['a'],
      expected: { kind: 'failed', message: "The resume point isn't in the transcript." },
    },
    { name: 'reports a failed read rather than throwing', mode: { kind: 'fork', sessionId: SESSION_ID }, uuids: null, expected: { kind: 'failed' } },
  ])('$name', async ({ mode, uuids, expected }) => {
    const result = await readHistory(await ctxWith(uuids), mode)
    if (result.kind === 'loaded') {
      expect({ kind: result.kind, uuids: uuidsOf(result.entries), omittedBefore: result.omittedBefore }).toEqual(expected)
      expect(result.sourceSessionId).toBe(SESSION_ID)
      return
    }
    expect(result).toMatchObject(expected as object)
  })

  it('keeps only the last HISTORY_LIMIT entries, counting the rest as omittedBefore', async () => {
    const uuids = Array.from({ length: HISTORY_LIMIT + 10 }, (_, i) => `e${String(i)}`)
    const result = await readHistory(await ctxWith(uuids), resume)
    if (result.kind !== 'loaded') throw new Error('expected loaded')
    expect(result.omittedBefore).toBe(10)
    expect(result.entries).toHaveLength(HISTORY_LIMIT)
    expect(result.entries[0]?.uuid).toBe('e10')
  })
})
