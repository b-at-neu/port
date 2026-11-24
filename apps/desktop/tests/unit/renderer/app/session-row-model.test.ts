import { describe, expect, it } from 'vitest'
import type { HostedSessionSnapshot, SessionPhase } from '@/types/hosting'
import { dotFor, sessionStateLabel } from '@/renderer/app/session-row-model'

type Permission = HostedSessionSnapshot['pendingPermissions'][number]

function permission(interaction: Permission['interaction']): Permission {
  return { permissionId: 'p1', toolName: 'Bash', input: {}, title: null, displayName: null, description: null, decisionReason: null, blockedPath: null, protectedPath: null, agentId: null, requestedAt: '2026-01-01T00:00:00.000Z', sessionGrant: null, interaction }
}

function session(phase: SessionPhase, pendingPermissions: readonly Permission[] = []): Pick<HostedSessionSnapshot, 'phase' | 'pendingPermissions'> {
  return { phase, pendingPermissions }
}

describe('sessionStateLabel', () => {
  it('gives every phase its own label', () => {
    const phases = ['starting', 'streaming', 'interrupting', 'closing', 'ready', 'ended'] as const
    expect(new Set(phases.map((phase) => sessionStateLabel(session(phase)))).size).toBe(phases.length)
  })

  it('reads a bare pending permission as waiting for the operator, over the phase', () => {
    expect(sessionStateLabel(session('streaming', [permission(null)]))).not.toBe(sessionStateLabel(session('streaming')))
  })
})

describe('dotFor', () => {
  it('pulses only while the session waits on the operator', () => {
    expect(dotFor(session('streaming', [permission(null)])).className).toContain('animate-pulse')
    expect(dotFor(session('streaming')).className).not.toContain('animate-pulse')
    expect(dotFor(session('ready')).className).not.toContain('animate-pulse')
  })

  it('keeps the working and idle colours', () => {
    expect(dotFor(session('starting')).className).toBe('bg-working-dot')
    expect(dotFor(session('streaming')).className).toBe('bg-working-dot')
    expect(dotFor(session('ready')).className).toBe('bg-idle-dot')
  })
})
