import { describe, expect, it } from 'vitest'
import type { PipelineFailureKind } from '../../../shared/github/types'
import { backlogEmptyGroupCopy, backlogFailureCopy, backlogInvokeErrorCopy, backlogNotReadyCopy, backlogTruncatedCopy } from './copy'

const EVERY_KIND: readonly PipelineFailureKind[] = [
  'not-found',
  'cwd-missing',
  'signalled',
  'timeout',
  'output-too-large',
  'spawn-failed',
  'unauthenticated',
  'rate-limited',
  'forbidden',
  'http-not-found',
  'network',
  'unknown',
  'unparseable',
  'no-data',
  'repo-not-found',
]

describe('backlogFailureCopy', () => {
  it('maps every failure kind to non-empty copy', () => {
    for (const kind of EVERY_KIND) {
      expect(backlogFailureCopy('acme/widgets', kind, 'detail')).not.toBe('')
    }
  })

  it('unauthenticated names gh auth login', () => {
    expect(backlogFailureCopy('acme/widgets', 'unauthenticated', '')).toContain('gh auth login')
  })

  it('not-found names installing gh', () => {
    expect(backlogFailureCopy('acme/widgets', 'not-found', '')).toContain("isn't installed")
  })

  it('rate-limited names the rate limit', () => {
    expect(backlogFailureCopy('acme/widgets', 'rate-limited', '')).toContain('rate limit')
  })

  it.each(['network', 'timeout'] as const)('%s names the connection', (kind) => {
    expect(backlogFailureCopy('acme/widgets', kind, '')).toContain('connection')
  })

  it.each(['repo-not-found', 'http-not-found', 'forbidden'] as const)('%s names the repository', (kind) => {
    expect(backlogFailureCopy('acme/widgets', kind, '')).toContain('acme/widgets')
  })

  it('an unrecognised kind falls through to the raw message', () => {
    expect(backlogFailureCopy('acme/widgets', 'unknown', 'boom')).toContain('boom')
  })
})

describe('other backlog copy', () => {
  it('truncated names the scanned count', () => {
    expect(backlogTruncatedCopy(100)).toContain('100')
  })

  it('invoke error names the repository', () => {
    expect(backlogInvokeErrorCopy('acme/widgets')).toContain('acme/widgets')
  })

  it('empty group names the repository', () => {
    expect(backlogEmptyGroupCopy('acme/widgets')).toContain('acme/widgets')
  })

  it('not-ready names the repository', () => {
    expect(backlogNotReadyCopy('acme/legacy-site')).toContain('acme/legacy-site')
  })
})
