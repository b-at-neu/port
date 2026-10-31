import { describe, expect, it } from 'vitest'
import type { PhaseTone } from '@/types/components'
import type { SessionKey } from '@/types/hosting'
import type { RepoId } from '@/utils/repos'
import type { PipelineRow, PipelineSessionRow, SidebarSelection } from '@/types/shell'
import { isPipelineRowSelected, isUserSessionSelected, repoHoldsSelection, repoToggleLabel, selectedPipelineRowKey, sidebarSelectionOf } from '@/renderer/shell/sidebar-selection'

const key = (value: string) => value as SessionKey

const TONE: PhaseTone = { palette: 'unstaged', fill: 'active', pulse: false }

function stageRow(rowKey: string, sessionKey: string): PipelineSessionRow {
  return { key: rowKey, repoId: 'a' as RepoId, number: 1, label: '#1', tone: TONE, statusText: 'Implement', sessionKey: key(sessionKey), transcript: null }
}

function detectedRow(rowKey: string, sessionId: string, agentId: string | null): PipelineSessionRow {
  return { key: rowKey, repoId: 'a' as RepoId, number: 2, label: '#2', tone: TONE, statusText: 'Implement', sessionKey: null, transcript: { sessionId, agentId } }
}

function repo(repoId: string, sessions: readonly PipelineSessionRow[]): PipelineRow {
  return { ready: false, repoId: repoId as RepoId, name: repoId, sessions }
}

const NONE = { sessionKey: undefined, transcriptSessionId: undefined, transcriptAgentId: undefined }

describe('sidebarSelectionOf', () => {
  it('reads a session key', () => {
    expect(sidebarSelectionOf({ ...NONE, sessionKey: 'k1' })).toEqual({ kind: 'session', sessionKey: 'k1' })
  })

  it('reads a transcript with an agent id', () => {
    expect(sidebarSelectionOf({ ...NONE, transcriptSessionId: 's1', transcriptAgentId: 'ag' })).toEqual({ kind: 'transcript', sessionId: 's1', agentId: 'ag' })
  })

  it('reads a whole-session transcript as a null agent id', () => {
    expect(sidebarSelectionOf({ ...NONE, transcriptSessionId: 's1', transcriptAgentId: null })).toEqual({ kind: 'transcript', sessionId: 's1', agentId: null })
    expect(sidebarSelectionOf({ ...NONE, transcriptSessionId: 's1' })).toEqual({ kind: 'transcript', sessionId: 's1', agentId: null })
  })

  it('gives null for empty or absent values', () => {
    expect(sidebarSelectionOf(NONE)).toBeNull()
    expect(sidebarSelectionOf({ sessionKey: '', transcriptSessionId: '', transcriptAgentId: null })).toBeNull()
    expect(sidebarSelectionOf({ sessionKey: null, transcriptSessionId: undefined, transcriptAgentId: undefined })).toBeNull()
  })
})

describe('isUserSessionSelected', () => {
  it('matches only an equal session key', () => {
    expect(isUserSessionSelected(key('k1'), { kind: 'session', sessionKey: key('k1') })).toBe(true)
    expect(isUserSessionSelected(key('k1'), { kind: 'session', sessionKey: key('k2') })).toBe(false)
  })

  it('is false for a transcript selection or none', () => {
    expect(isUserSessionSelected(key('k1'), { kind: 'transcript', sessionId: 'k1', agentId: null })).toBe(false)
    expect(isUserSessionSelected(key('k1'), null)).toBe(false)
  })
})

describe('isPipelineRowSelected', () => {
  it('matches a stage row by session key only', () => {
    const row = stageRow('r1', 'k1')
    expect(isPipelineRowSelected(row, { kind: 'session', sessionKey: key('k1') })).toBe(true)
    expect(isPipelineRowSelected(row, { kind: 'session', sessionKey: key('k2') })).toBe(false)
    expect(isPipelineRowSelected(row, { kind: 'transcript', sessionId: 'k1', agentId: null })).toBe(false)
  })

  it('needs both session id and agent id for a detected agent row', () => {
    const row = detectedRow('r2', 's1', 'ag')
    expect(isPipelineRowSelected(row, { kind: 'transcript', sessionId: 's1', agentId: 'ag' })).toBe(true)
    expect(isPipelineRowSelected(row, { kind: 'transcript', sessionId: 's1', agentId: 'other' })).toBe(false)
    expect(isPipelineRowSelected(row, { kind: 'transcript', sessionId: 's2', agentId: 'ag' })).toBe(false)
  })

  it('never matches a whole-session transcript to an agent row, or the reverse', () => {
    expect(isPipelineRowSelected(detectedRow('r2', 's1', 'ag'), { kind: 'transcript', sessionId: 's1', agentId: null })).toBe(false)
    expect(isPipelineRowSelected(detectedRow('r3', 's1', null), { kind: 'transcript', sessionId: 's1', agentId: 'ag' })).toBe(false)
    expect(isPipelineRowSelected(detectedRow('r3', 's1', null), { kind: 'transcript', sessionId: 's1', agentId: null })).toBe(true)
  })

  it('never matches a session selection to a transcript-only row, and none matches nothing', () => {
    expect(isPipelineRowSelected(detectedRow('r2', 's1', null), { kind: 'session', sessionKey: key('s1') })).toBe(false)
    expect(isPipelineRowSelected(stageRow('r1', 'k1'), null)).toBe(false)
  })
})

describe('repoHoldsSelection', () => {
  const row = repo('a', [stageRow('a1', 'x'), stageRow('a2', 'y')])

  it('is true for a collapsed repo holding the selected row', () => {
    expect(repoHoldsSelection(row, true, 'a2')).toBe(true)
  })

  it('is false for an expanded repo, since the row itself carries the selection', () => {
    expect(repoHoldsSelection(row, false, 'a2')).toBe(false)
  })

  it('is false when nothing is selected or the selection is in another repo', () => {
    expect(repoHoldsSelection(row, true, null)).toBe(false)
    expect(repoHoldsSelection(row, true, 'b1')).toBe(false)
  })
})

describe('repoToggleLabel', () => {
  it('names the action by collapse state', () => {
    expect(repoToggleLabel('acme/widgets', false, false)).toBe('Collapse acme/widgets')
    expect(repoToggleLabel('acme/widgets', true, false)).toBe('Expand acme/widgets')
  })

  it('says a collapsed repo contains the open session', () => {
    expect(repoToggleLabel('acme/widgets', true, true)).toBe('Expand acme/widgets, contains the open session')
  })
})

describe('selectedPipelineRowKey', () => {
  it('returns the first match across repos', () => {
    const rows = [repo('a', [stageRow('a1', 'x')]), repo('b', [stageRow('b1', 'k1')]), repo('c', [stageRow('c1', 'k1')])]
    expect(selectedPipelineRowKey(rows, { kind: 'session', sessionKey: key('k1') })).toBe('b1')
  })

  it('returns null when nothing matches or the selection is null', () => {
    const rows = [repo('a', [stageRow('a1', 'x')])]
    const none: SidebarSelection = null
    expect(selectedPipelineRowKey(rows, { kind: 'session', sessionKey: key('missing') })).toBeNull()
    expect(selectedPipelineRowKey(rows, none)).toBeNull()
  })
})
