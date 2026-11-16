import { describe, expect, it } from 'vitest'
import type { PipelineFailureKind } from '@/types/github'
import {
  BACKLOG_DETAIL_NONE,
  BACKLOG_DETAIL_NO_BODY,
  BACKLOG_DETAIL_UNASSIGNED,
  BACKLOG_DETAIL_UNREADABLE,
  BACKLOG_EPIC_SUBISSUES_UNREADABLE,
  BACKLOG_META_ASSIGNEE,
  BACKLOG_META_AUTHOR,
  BACKLOG_META_BLOCKED_BY,
  BACKLOG_META_BLOCKS,
  BACKLOG_META_CAN_START,
  BACKLOG_META_DONE,
  BACKLOG_META_IN_PROGRESS,
  BACKLOG_META_OPENED,
  BACKLOG_META_UPDATED,
  backlogBlockedReasonCopy,
  backlogBlockerLine,
  backlogBlockerTruncatedCopy,
  backlogDetailFailureCopy,
  backlogDetailInvokeErrorCopy,
  backlogDetailMoreCopy,
  backlogDetailRegionAria,
  backlogDetailToggleAria,
  backlogEmptyGroupCopy,
  backlogEpicDoneCopy,
  backlogEpicInfoAria,
  backlogEpicInProgressCopy,
  BACKLOG_EPIC_TAG,
  backlogEpicProgressAria,
  backlogEpicProgressCopy,
  backlogEpicReasonCopy,
  backlogEpicToggleAria,
  backlogEpicTruncatedCopy,
  backlogFailureCopy,
  backlogGroupToggleAria,
  backlogInvokeErrorCopy,
  backlogNotReadyCopy,
  backlogRepoFilterButtonCopy,
  backlogStartAnywayTitle,
  backlogTruncatedCopy,
  backlogWaveBandCopy,
  backlogWaveLabel,
} from '@/renderer/backlog/copy'

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

describe('blocked and epic confirmation copy', () => {
  it('names the ticket in the dialog title', () => {
    expect(backlogStartAnywayTitle(552)).toBe('Start #552 anyway?')
  })

  it('pluralises the blocked reason', () => {
    expect(backlogBlockedReasonCopy(1)).toBe("It's blocked by 1 open ticket:")
    expect(backlogBlockedReasonCopy(2)).toBe("It's blocked by 2 open tickets:")
  })

  it('pluralises the epic reason', () => {
    expect(backlogEpicReasonCopy(1)).toBe('It has 1 sub-issue. Work on it happens in its sub-issue.')
    expect(backlogEpicReasonCopy(21)).toBe('It has 21 sub-issues. Work on it happens in its sub-issues.')
  })

  it('renders a blocker as its number and title', () => {
    expect(backlogBlockerLine({ number: 454, title: 'Audit log screen' })).toBe('#454 Audit log screen')
  })

  it('states how many blockers are shown of the total', () => {
    expect(backlogBlockerTruncatedCopy(10, 14)).toBe('Showing 10 of 14 blockers.')
  })
})

describe('repository section copy', () => {
  it('names the repository filter by how many are shown', () => {
    expect(backlogRepoFilterButtonCopy(3, 3)).toBe('Repositories')
    expect(backlogRepoFilterButtonCopy(2, 3)).toBe('Repositories · 2 of 3')
    expect(backlogRepoFilterButtonCopy(0, 3)).toBe('Repositories · 0 of 3')
  })

  it('labels the group toggle by what it will do', () => {
    expect(backlogGroupToggleAria('acme/widgets', false)).toBe('Collapse acme/widgets')
    expect(backlogGroupToggleAria('acme/widgets', true)).toBe('Expand acme/widgets')
  })
})

describe('detail copy', () => {
  it('labels the toggles by what they will do', () => {
    expect(backlogDetailToggleAria(45, false)).toBe('Show details for #45')
    expect(backlogDetailToggleAria(45, true)).toBe('Hide details for #45')
    expect(backlogEpicInfoAria(41, false)).toBe('Show info for #41')
    expect(backlogEpicInfoAria(41, true)).toBe('Hide info for #41')
    expect(backlogDetailRegionAria(45)).toBe('Details for #45')
  })

  it('names the meta fields', () => {
    expect([BACKLOG_META_BLOCKED_BY, BACKLOG_META_BLOCKS, BACKLOG_META_AUTHOR, BACKLOG_META_UPDATED, BACKLOG_META_ASSIGNEE, BACKLOG_META_DONE, BACKLOG_META_IN_PROGRESS, BACKLOG_META_CAN_START, BACKLOG_META_OPENED]).toEqual([
      'Blocked by',
      'Blocks',
      'Author',
      'Updated',
      'Assignee',
      'Done',
      'In progress',
      'Can start now',
      'Opened',
    ])
  })

  it('words the empty and unreadable values', () => {
    expect(BACKLOG_DETAIL_NONE).toBe('None')
    expect(BACKLOG_DETAIL_UNASSIGNED).toBe('Unassigned')
    expect(BACKLOG_DETAIL_NO_BODY).toBe('No description.')
    expect(BACKLOG_DETAIL_UNREADABLE).toBe("Couldn't read")
    expect(BACKLOG_EPIC_SUBISSUES_UNREADABLE).toBe("Couldn't read sub-issues")
  })

  it('words the counts', () => {
    expect(backlogDetailMoreCopy(2)).toBe('+2 more')
    expect(backlogEpicDoneCopy(1, 3)).toBe('1 of 3 done')
    expect(backlogEpicInProgressCopy(1)).toBe('1 in progress')
  })

  it('words a failed read by its kind', () => {
    expect(backlogDetailFailureCopy(45, 'issue-missing', '')).toBe('#45 is no longer an open ticket. Refresh the backlog.')
    expect(backlogDetailFailureCopy(45, 'issue-closed', '')).toBe('#45 was closed. Refresh the backlog.')
    expect(backlogDetailFailureCopy(45, 'rate-limited', '')).toContain('rate limit')
    expect(backlogDetailFailureCopy(45, 'no-data', 'boom')).toBe("Couldn't load the details of #45: boom")
  })

  it('words a rejected invoke', () => {
    expect(backlogDetailInvokeErrorCopy(45)).toBe("Couldn't load the details of #45. Retry, or refresh the backlog.")
  })
})

describe('epic and wave copy', () => {
  it('names the epic tag, waves and band', () => {
    expect(BACKLOG_EPIC_TAG).toBe('Epic')
    expect(backlogWaveLabel(2)).toBe('Wave 2')
    expect(backlogWaveBandCopy(2, 1)).toBe('Wave 2 · 1 in progress')
  })

  it('words the progress, its accessible name and the truncation note', () => {
    expect(backlogEpicProgressCopy(1, 3)).toBe('1/3')
    expect(backlogEpicProgressAria(1, 3)).toBe('1 of 3 sub-issues done')
    expect(backlogEpicTruncatedCopy(50, 70)).toBe('Counted 50 of 70 sub-issues.')
  })

  it('labels the epic toggle by what it will do', () => {
    expect(backlogEpicToggleAria(41, false)).toBe('Collapse #41')
    expect(backlogEpicToggleAria(41, true)).toBe('Expand #41')
  })
})
