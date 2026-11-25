import { describe, expect, it } from 'vitest'
import { argumentRequired, composerState, controlsDisabledReason, isWorking, oldestInteraction, sendErrorOf, sessionPageOf, waitingLabelOf } from '@/renderer/session/model'
import { PIPELINE_SEND_BLOCKED, SEND_FAILED_UNKNOWN_SESSION, SEND_FAILED_UNREACHABLE, STAGE_COMMAND_BLOCKED } from '@/renderer/session/copy'
import type { PendingPermission, SessionPhase } from '@/types/hosting'
import type { PendingInteraction } from '@/utils/hosting/controls'
import { sessionSnapshot } from '../../../support/session-snapshot'

const PHASES: readonly SessionPhase[] = ['starting', 'ready', 'streaming', 'interrupting', 'closing', 'ended']

function permission(id: string, requestedAt: string, interaction: PendingInteraction | null): PendingPermission {
  return {
    permissionId: id,
    toolName: 'Bash',
    input: {},
    title: null,
    displayName: null,
    description: null,
    decisionReason: null,
    blockedPath: null,
    protectedPath: null,
    agentId: null,
    requestedAt,
    interaction,
  } as PendingPermission
}

const QUESTION: PendingInteraction = { kind: 'question', questions: [] }
const PLAN: PendingInteraction = { kind: 'plan', plan: 'p' }

describe('sessionPageOf', () => {
  const found = sessionSnapshot()
  const other = sessionSnapshot({ sessionKey: 'hosted-2' as typeof found.sessionKey })

  it.each([
    ['no key', null, { data: [found], status: 'success' as const }, 'empty'],
    ['key found', found.sessionKey, { data: [found], status: 'success' as const }, 'ready'],
    ['pending without data', found.sessionKey, { data: undefined, status: 'pending' as const }, 'loading'],
    ['error without data', found.sessionKey, { data: undefined, status: 'error' as const }, 'error'],
    ['loaded list without the key', found.sessionKey, { data: [other], status: 'success' as const }, 'empty'],
    ['error with stale data holding the key', found.sessionKey, { data: [found], status: 'error' as const }, 'ready'],
  ])('%s', (_name, key, sessions, kind) => {
    expect(sessionPageOf(key, sessions).kind).toBe(kind)
  })
})

describe('isWorking', () => {
  it.each(PHASES)('%s', (phase) => {
    expect(isWorking(phase)).toBe(phase === 'streaming' || phase === 'interrupting')
  })
})

describe('oldestInteraction', () => {
  it('is null with nothing pending or only bare permissions', () => {
    expect(oldestInteraction([])).toBeNull()
    expect(oldestInteraction([permission('a', '2026-01-01T00:00:00Z', null)])).toBeNull()
  })

  it('picks the oldest permission that carries an interaction', () => {
    const pending = [permission('late', '2026-01-01T00:02:00Z', PLAN), permission('bare', '2026-01-01T00:00:00Z', null), permission('early', '2026-01-01T00:01:00Z', QUESTION)]
    expect(oldestInteraction(pending)?.permissionId).toBe('early')
  })
})

describe('waitingLabelOf', () => {
  it('is null when nothing is pending', () => {
    expect(waitingLabelOf({ pendingPermissions: [] })).toBeNull()
  })

  it('reads a bare permission and an interaction differently', () => {
    const bare = waitingLabelOf({ pendingPermissions: [permission('a', 't', null)] })
    const question = waitingLabelOf({ pendingPermissions: [permission('a', 't', QUESTION)] })
    const plan = waitingLabelOf({ pendingPermissions: [permission('a', 't', PLAN)] })
    expect(new Set([bare, question, plan]).size).toBe(3)
  })
})

describe('composerState', () => {
  it.each(PHASES)('%s without an interaction follows the phase', (phase) => {
    const state = composerState(phase, false, null)
    expect(state.disabled).toBe(phase === 'closing' || phase === 'ended')
    expect(state.sendLabel === null).toBe(phase === 'closing' || phase === 'ended')
  })

  it.each(PHASES)('%s with a gone session is disabled', (phase) => {
    expect(composerState(phase, true, null).disabled).toBe(true)
  })

  it.each([QUESTION, PLAN])('a pending $kind disables the composer and replaces the placeholder', (interaction) => {
    const plain = composerState('ready', false, null)
    const state = composerState('ready', false, interaction)
    expect(state.disabled).toBe(true)
    expect(state.placeholder).not.toBe(plain.placeholder)
    expect(state.sendLabel).toBe(plain.sendLabel)
  })

  it('words a question and a plan differently', () => {
    expect(composerState('ready', false, QUESTION).placeholder).not.toBe(composerState('ready', false, PLAN).placeholder)
  })
})

describe('controlsDisabledReason', () => {
  it.each(PHASES)('%s', (phase) => {
    const reason = controlsDisabledReason(phase)
    expect(reason === null).toBe(phase === 'ready' || phase === 'streaming' || phase === 'interrupting')
  })
})

describe('sendErrorOf', () => {
  it.each([
    ['unknown-session', false, SEND_FAILED_UNKNOWN_SESSION],
    ['blocked-command', true, STAGE_COMMAND_BLOCKED],
    ['blocked-command', false, PIPELINE_SEND_BLOCKED],
    ['unreachable', false, SEND_FAILED_UNREACHABLE],
    [null, false, SEND_FAILED_UNREACHABLE],
  ])('%s in a stage: %s', (error, inStage, expected) => {
    expect(sendErrorOf(error, inStage)).toBe(expected)
  })
})

describe('argumentRequired', () => {
  it.each([
    ['<feature description>', true],
    ['[optional]', false],
    ['', false],
    ['a description', false],
  ])('%j', (hint, expected) => {
    expect(argumentRequired(hint)).toBe(expected)
  })
})
