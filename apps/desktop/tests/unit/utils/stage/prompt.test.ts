import { describe, expect, it } from 'vitest'
import { composeStagePrompt, parseStagePrompt, stageModeOf } from '@/utils/stage/prompt'
import type { LabelKey } from '@/utils/labels/vocabulary'

const IMPL_HEADER = 'Implementation stage for issue #12. Run your pipeline stage for #12. Follow your Pre-flight, Label swap, Work, and Handoff steps exactly.'
const SOURCE = '/home/u/.claude/plugins/cache/port/port/1.0.0'

describe('stage mode', () => {
  it.each<[LabelKey, string]>([
    ['ready', 'fresh'],
    ['planChangesRequested', 'revision'],
    ['planApproved', 'implement'],
    ['readyForReview', 'review'],
    ['needsRevision', 'revise'],
    ['refreshBranch', 'refresh'],
  ])('maps the %s trigger to %s', (trigger, mode) => {
    expect(stageModeOf(trigger)).toBe(mode)
  })

  it('has no mode for an in-flight label', () => {
    expect(stageModeOf('inProgress')).toBeNull()
  })
})

describe('compose and parse', () => {
  it('round-trips the header, source and multi-paragraph instructions', () => {
    const text = composeStagePrompt({ header: IMPL_HEADER, context: [['stage', 'impl'], ['mode', 'implement']], instructions: 'You are the agent.\n\nSecond paragraph.', source: SOURCE })
    expect(text.startsWith(`${IMPL_HEADER}\n\n<port-stage-context>\nstage: impl\nmode: implement\n</port-stage-context>`)).toBe(true)
    expect(parseStagePrompt(text)).toEqual({ stage: 'impl', kind: 'issue', number: 12, instructions: 'You are the agent.\n\nSecond paragraph.', source: SOURCE })
  })

  it('parses a bare dispatch one-liner with no instructions', () => {
    expect(parseStagePrompt(IMPL_HEADER)).toEqual({ stage: 'impl', kind: 'issue', number: 12, instructions: null, source: null })
  })

  it('reads a truncated text with no closing tag to its end', () => {
    const full = composeStagePrompt({ header: IMPL_HEADER, context: [['stage', 'impl']], instructions: 'one two three', source: '/p' })
    const cut = full.slice(0, full.indexOf('three') + 3)
    expect(parseStagePrompt(cut)).toEqual({ stage: 'impl', kind: 'issue', number: 12, instructions: 'one two thr', source: '/p' })
  })

  it('does not match text that merely mentions a stage', () => {
    expect(parseStagePrompt('Please explain the Plan stage for issue #5 to me.')).toBeNull()
    expect(parseStagePrompt('Add a loading state to the repositories table.')).toBeNull()
    expect(parseStagePrompt('')).toBeNull()
  })

  it('keeps a quote in the source from breaking the attribute', () => {
    const text = composeStagePrompt({ header: IMPL_HEADER, context: [], instructions: 'x', source: '/a"b' })
    expect(parseStagePrompt(text)?.source).toBe("/a'b")
  })
})
