import { describe, expect, it } from 'vitest'
import { roleOfTicket } from '@/main/pipeline/board/stage'
import type { Ticket } from '@/utils/pipeline/ticket'
import { NOW } from '../../../../support/tickets'

describe('roleOfTicket', () => {
  it.each([
    ['running', { kind: 'running', runId: null }, 'in-flight'],
    ['queued', { kind: 'queued', reason: 'new', since: NOW }, 'trigger'],
    ['held', { kind: 'held', on: 'paused', detail: '' }, 'trigger'],
    ['waiting-on-you', { kind: 'waiting-on-you', gate: 'merge', detail: '' }, 'gate'],
    ['blocked', { kind: 'blocked', on: [4], reason: '' }, 'gate'],
    ['done', { kind: 'done', at: NOW }, 'terminal'],
  ] as const satisfies readonly (readonly [string, Ticket['status'], string])[])('a %s ticket is %s', (_name, status, role) => {
    expect(roleOfTicket({ status })).toBe(role)
  })
})
