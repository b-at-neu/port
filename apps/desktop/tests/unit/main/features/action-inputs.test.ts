// The input schemas of the session-adjacent actions: what the router lets through to `run`.
import { describe, expect, it } from 'vitest'
import { actions } from '@/main/app/router'

const KEY = 'hosted-1'
const text = { kind: 'text', name: 'notes.txt', text: 'hi' }
const png = { kind: 'image', name: 'a.png', mediaType: 'image/png', data: 'QQ==' }

function accepts(name: string, input: unknown): boolean {
  const action = actions.find((candidate) => candidate.name === name)
  if (action === undefined) throw new Error(`no action named '${name}'`)
  return action.input.safeParse(input).success
}

const rows: { action: string; input: unknown; ok: boolean }[] = [
  { action: 'session.send', input: { sessionKey: KEY, text: 'hello' }, ok: true },
  { action: 'session.send', input: { sessionKey: KEY, text: '', attachments: [text] }, ok: true },
  { action: 'session.send', input: { sessionKey: KEY, text: '' }, ok: false },
  { action: 'session.send', input: { sessionKey: KEY, text: '', attachments: [{ kind: 'video', name: 'a' }] }, ok: false },
  { action: 'session.send', input: { sessionKey: KEY, text: '', attachments: [{ ...png, mediaType: 'image/heic' }] }, ok: false },
  { action: 'session.send', input: { sessionKey: KEY, text: '', attachments: [{ ...png, data: 'not base64!' }] }, ok: false },
  { action: 'session.send', input: { sessionKey: KEY, text: '', attachments: [{ ...png, data: 'A'.repeat(7_000_000) }] }, ok: false },
  { action: 'session.send', input: { sessionKey: KEY, text: '', attachments: Array.from({ length: 11 }, (_, i) => ({ ...text, name: `f${String(i)}.txt` })) }, ok: false },
  { action: 'session.send', input: { sessionKey: KEY, text: '', attachments: [{ ...text, name: 'a\u0007b' }] }, ok: false },
  { action: 'session.send', input: { sessionKey: '', text: 'hello' }, ok: false },
  { action: 'session.rename', input: { sessionKey: KEY, title: 'A title' }, ok: true },
  { action: 'session.rename', input: { sessionKey: KEY, title: '   ' }, ok: false },
  { action: 'session.controlsSet', input: { sessionKey: KEY, model: 'opus' }, ok: true },
  { action: 'session.controlsSet', input: { sessionKey: KEY }, ok: false },
  { action: 'session.controlsSet', input: { sessionKey: KEY, permissionMode: 'bypassPermissions' }, ok: false },
  { action: 'session.controlsSet', input: { sessionKey: KEY, effort: 'extreme' }, ok: false },
  { action: 'session.questionAnswer', input: { sessionKey: KEY, permissionId: 'p1', answers: { Q: 'a' } }, ok: true },
  { action: 'session.questionAnswer', input: { sessionKey: KEY, permissionId: 'p1', answers: null }, ok: false },
  { action: 'session.questionAnswer', input: { sessionKey: KEY, permissionId: 'p1', answers: { Q: 1 } }, ok: false },
  { action: 'session.planAnswer', input: { sessionKey: KEY, permissionId: 'p1', decision: { kind: 'approve', mode: 'default' } }, ok: true },
  { action: 'session.planAnswer', input: { sessionKey: KEY, permissionId: 'p1', decision: { kind: 'approve', mode: 'plan' } }, ok: false },
  { action: 'session.planAnswer', input: { sessionKey: KEY, permissionId: 'p1', decision: { kind: 'keep-planning', feedback: '' } }, ok: false },
  { action: 'session.permissionAnswer', input: { sessionKey: KEY, permissionId: 'p1', decision: 'deny', message: 'no' }, ok: true },
  { action: 'session.permissionAnswer', input: { sessionKey: KEY, permissionId: 'p1', decision: 'allow-once', message: 'no' }, ok: false },
  { action: 'session.start', input: { target: { kind: 'folder', folderId: 'f1', worktree: false }, mode: { kind: 'fresh' } }, ok: true },
  { action: 'session.start', input: { target: { kind: 'transcript' }, mode: { kind: 'fresh' } }, ok: false },
  { action: 'session.start', input: { target: { kind: 'transcript' }, mode: { kind: 'resume', sessionId: 's1' } }, ok: true },
  { action: 'session.capacitySet', input: { limit: 2 }, ok: true },
  { action: 'session.capacitySet', input: { limit: 0 }, ok: false },
  { action: 'session.capacitySet', input: { limit: 1.5 }, ok: false },
  { action: 'session.invoke', input: { sessionKey: KEY, name: 'compact', args: '' }, ok: true },
  { action: 'session.invoke', input: { sessionKey: KEY, name: 'compact', args: 'x'.repeat(8001) }, ok: false },
  { action: 'session.dismiss', input: { sessionKey: KEY, worktree: 'keep' }, ok: true },
  { action: 'session.dismiss', input: { sessionKey: KEY, worktree: 'maybe' }, ok: false },
  { action: 'session.restoreDiscard', input: { restoreId: null }, ok: true },
  { action: 'session.restoreDiscard', input: { restoreId: '' }, ok: false },
  { action: 'session.list', input: undefined, ok: true },
  { action: 'session.list', input: {}, ok: false },
  { action: 'notify.needsYou', input: { title: 'port', body: 'Review the plan', focus: null }, ok: true },
  { action: 'notify.needsYou', input: { title: 'x'.repeat(200), body: 'b', focus: null }, ok: true },
  { action: 'notify.needsYou', input: { title: '', body: 'b', focus: null }, ok: false },
  { action: 'notify.needsYou', input: { title: 't', body: 'x'.repeat(201), focus: null }, ok: false },
  { action: 'notify.needsYou', input: { title: 't', body: 'b' }, ok: false },
  { action: 'notify.prefsSet', input: { needsYou: true, sessions: false }, ok: true },
  { action: 'notify.prefsSet', input: { needsYou: 'yes', sessions: true }, ok: false },
  { action: 'notify.prefsSet', input: { needsYou: true }, ok: false },
  { action: 'transcript.tailOpen', input: { sessionId: 's1', agentId: null }, ok: true },
  { action: 'transcript.tailOpen', input: { sessionId: '', agentId: null }, ok: false },
  { action: 'transcript.tailOpen', input: { sessionId: 's1', agentId: 42 }, ok: false },
  { action: 'transcript.tailPoll', input: { tailId: '' }, ok: false },
  { action: 'search.query', input: { query: 'needle', scope: { kind: 'all' } }, ok: true },
  { action: 'search.query', input: { query: '', scope: { kind: 'all' } }, ok: false },
  { action: 'search.query', input: { query: 'needle', scope: { kind: 'other' } }, ok: false },
  { action: 'search.query', input: { query: 'needle', scope: { kind: 'repo' } }, ok: false },
  { action: 'runtime.probe', input: { repoId: null }, ok: true },
  { action: 'runtime.probe', input: { repoId: 'repo-1' }, ok: true },
  { action: 'runtime.probe', input: { repoId: '' }, ok: false },
  { action: 'runtime.probe', input: {}, ok: false },
]

describe('action inputs', () => {
  it.each(rows)('$action $ok: $input', ({ action, input, ok }) => {
    expect(accepts(action, input)).toBe(ok)
  })

  it('trims a rename title before it reaches run', () => {
    const action = actions.find((candidate) => candidate.name === 'session.rename')
    expect(action?.input.parse({ sessionKey: KEY, title: '  A title  ' })).toEqual({ sessionKey: KEY, title: 'A title' })
  })
})
