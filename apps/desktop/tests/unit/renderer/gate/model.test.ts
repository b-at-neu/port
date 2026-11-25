import { describe, expect, it } from 'vitest'
import { gateStepOf } from '@/renderer/gate/model'
import type { GatePreflight, GatePreflightResponse } from '@/types/gate'

const OWNERSHIP = { kind: 'absent' } as const

const PREFLIGHT = { number: 7, title: 'T' } as GatePreflight

function resolved(verdict: Extract<GatePreflightResponse, { kind: 'resolved' }>['verdict']): GatePreflightResponse {
  return { kind: 'resolved', preflight: PREFLIGHT, verdict, ownership: OWNERSHIP }
}

const ANSWERABLE = { kind: 'answerable', noPlanBlock: false, assignedElsewhere: [] } as const

describe('gateStepOf', () => {
  it.each([
    ['fetching with data', { data: resolved(ANSWERABLE), isError: false, isFetching: true }, 'loading'],
    ['fetching after an error', { data: undefined, isError: true, isFetching: true }, 'loading'],
    ['an error', { data: undefined, isError: true, isFetching: false }, 'failed'],
    ['pending with no data', { data: undefined, isError: false, isFetching: false }, 'loading'],
    ['a failed read', { data: { kind: 'failed', message: 'x', ownership: OWNERSHIP }, isError: false, isFetching: false }, 'failed'],
    ['an unresolved issue', { data: { kind: 'unresolved', ownership: OWNERSHIP }, isError: false, isFetching: false }, 'refused'],
    ['a not-found verdict', { data: resolved({ kind: 'not-found' }), isError: false, isFetching: false }, 'refused'],
    ['a not-an-issue verdict', { data: resolved({ kind: 'not-an-issue' }), isError: false, isFetching: false }, 'refused'],
    ['a not-at-plan-review verdict', { data: resolved({ kind: 'not-at-plan-review', observed: [] }), isError: false, isFetching: false }, 'refused'],
    ['an answerable verdict', { data: resolved(ANSWERABLE), isError: false, isFetching: false }, 'reviewing'],
  ] as const)('%s is %s', (_name, query, kind) => {
    expect(gateStepOf(query).kind).toBe(kind)
  })

  it('names the unresolved issue as not-found', () => {
    expect(gateStepOf({ data: { kind: 'unresolved', ownership: OWNERSHIP }, isError: false, isFetching: false })).toEqual({ kind: 'refused', verdict: { kind: 'not-found' } })
  })
})
