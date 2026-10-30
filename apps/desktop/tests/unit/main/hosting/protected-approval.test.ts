import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHostedHandle } from '@/main/hosting/handle'
import { pathOps } from '@/main/platform/paths'
import { needsYouItems } from '@/renderer/board/needs-you'
import { boardSnapshot } from '../../../fixtures/board-state'
import { baseParams, fakeQuery, flush } from '../../../fixtures/hosting/handle'

type CanUseTool = (toolName: string, input: Record<string, unknown>, options: unknown) => Promise<unknown>

const STAGE = { tag: { agent: 'impl', number: 466, kind: 'issue', trigger: 'planApproved' } as const, agentName: 'port:impl-agent', model: 'sonnet', sessionRequiredPaths: ['.claude/**'], editAllow: [] }
const NOW = new Date('2026-01-01T01:00:00.000Z')
const CWD = resolve('/repo')

function inRepo(...segments: string[]): string {
  return pathOps.join(CWD, ...segments)
}

function startStage() {
  const fake = fakeQuery()
  let canUseTool: CanUseTool | undefined
  const handle = createHostedHandle(baseParams({ stage: STAGE, cwd: CWD }), (queryParams) => {
    canUseTool = (queryParams.options as { canUseTool?: CanUseTool }).canUseTool
    return fake.query
  })
  const call = (toolName: string, input: Record<string, unknown>): Promise<unknown> => {
    if (canUseTool === undefined) throw new Error('the session never passed canUseTool to query()')
    return canUseTool(toolName, input, { signal: new AbortController().signal, toolUseID: 'tool-use-1' })
  }
  return { handle, call }
}

describe('an app-owned stage session editing a protected path', () => {
  it('pauses for a Needs you approval instead of denying, and resumes once approved', async () => {
    const { handle, call } = startStage()
    let settled = false
    const result = call('Edit', { file_path: inRepo('.claude', 'settings.json') })
    void result.then(() => {
      settled = true
    })
    await flush()
    expect(settled).toBe(false)

    const items = needsYouItems(boardSnapshot(), NOW, [handle.snapshot()])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'stage-approval', path: '.claude/settings.json', toolName: 'Edit', agent: 'impl', number: 466 })

    const permissionId = handle.snapshot().pendingPermissions[0]?.permissionId as string
    expect(handle.answerPermission(permissionId, 'allow-once', null)).toEqual({ ok: true })
    await expect(result).resolves.toMatchObject({ behavior: 'allow' })
    expect(needsYouItems(boardSnapshot(), NOW, [handle.snapshot()])).toEqual([])
  })

  it('resolves a denied approval as a deny carrying the operator message', async () => {
    const { handle, call } = startStage()
    const result = call('Write', { file_path: inRepo('.claude', 'agents', 'x.md') })
    await flush()
    const permissionId = handle.snapshot().pendingPermissions[0]?.permissionId as string
    expect(handle.answerPermission(permissionId, 'deny', 'no thanks')).toEqual({ ok: true })
    await expect(result).resolves.toMatchObject({ behavior: 'deny', message: 'no thanks' })
  })

  it('raises one item per pending protected edit', async () => {
    const { handle, call } = startStage()
    void call('Edit', { file_path: inRepo('.claude', 'settings.json') })
    void call('Write', { file_path: inRepo('.claude', 'agents', 'x.md') })
    await flush()
    const items = needsYouItems(boardSnapshot(), NOW, [handle.snapshot()])
    expect(items.map((item) => (item.kind === 'stage-approval' ? item.path : null)).sort()).toEqual(['.claude/agents/x.md', '.claude/settings.json'])
  })

  it('denies an edit outside sessionRequiredPaths at once and raises no item', async () => {
    const { handle, call } = startStage()
    await expect(call('Edit', { file_path: inRepo('src', 'index.ts') })).resolves.toMatchObject({ behavior: 'deny' })
    expect(handle.snapshot().pendingPermissions).toEqual([])
    expect(needsYouItems(boardSnapshot(), NOW, [handle.snapshot()])).toEqual([])
  })
})
