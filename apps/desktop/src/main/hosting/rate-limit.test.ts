import { describe, expect, it } from 'vitest'
import { readRateLimit } from './rate-limit'

const OBSERVED_AT = '2026-01-05T12:00:00.000Z'

describe('readRateLimit', () => {
  it('returns null for a non-object message', () => {
    expect(readRateLimit('nope', OBSERVED_AT)).toBeNull()
  })

  it('returns null for a message of a different type', () => {
    expect(readRateLimit({ type: 'result' }, OBSERVED_AT)).toBeNull()
  })

  it('returns null when rate_limit_info is missing or not an object', () => {
    expect(readRateLimit({ type: 'rate_limit_event' }, OBSERVED_AT)).toBeNull()
    expect(readRateLimit({ type: 'rate_limit_event', rate_limit_info: 'nope' }, OBSERVED_AT)).toBeNull()
  })

  it('maps each known status', () => {
    expect(readRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, OBSERVED_AT)?.status).toBe('allowed')
    expect(readRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } }, OBSERVED_AT)?.status).toBe('warning')
    expect(readRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }, OBSERVED_AT)?.status).toBe('rejected')
  })

  it('returns null for an unknown status, leaving the previous reading to the caller', () => {
    expect(readRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'mystery' } }, OBSERVED_AT)).toBeNull()
  })

  it('maps each known window', () => {
    const windowFor = (rateLimitType: string) => readRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType } }, OBSERVED_AT)?.window
    expect(windowFor('five_hour')).toBe('five-hour')
    expect(windowFor('seven_day')).toBe('weekly')
    expect(windowFor('seven_day_overage_included')).toBe('weekly')
    expect(windowFor('seven_day_opus')).toBe('weekly-opus')
    expect(windowFor('seven_day_sonnet')).toBe('weekly-sonnet')
    expect(windowFor('overage')).toBe('overage')
  })

  it('reports window: null when absent or unrecognised', () => {
    expect(readRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, OBSERVED_AT)?.window).toBeNull()
    expect(readRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'mystery' } }, OBSERVED_AT)?.window).toBeNull()
  })

  it('reads resetsAt as seconds below 1e11', () => {
    const result = readRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1_800_000_000 } }, OBSERVED_AT)
    expect(result?.resetsAt).toBe(new Date(1_800_000_000 * 1000).toISOString())
  })

  it('reads resetsAt as milliseconds at or above 1e11', () => {
    const millis = 1_800_000_000_000
    const result = readRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: millis } }, OBSERVED_AT)
    expect(result?.resetsAt).toBe(new Date(millis).toISOString())
  })

  it('reports resetsAt: null for anything that is not a finite number', () => {
    expect(readRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 'soon' } }, OBSERVED_AT)?.resetsAt).toBeNull()
    expect(readRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, OBSERVED_AT)?.resetsAt).toBeNull()
  })

  it('carries observedAt verbatim', () => {
    expect(readRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, OBSERVED_AT)?.observedAt).toBe(OBSERVED_AT)
  })
})
