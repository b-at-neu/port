import { describe, expect, it } from 'vitest'
import { composeStageSystemPrompt, parseStagePrompt, stageModeOf, STAGE_SYSTEM_PREAMBLE, withStageInstructions } from '@/utils/stage/prompt'
import { ticketViewOf } from '@/utils/pipeline/stages'
import { queuedAt, ticketAt } from '../../../support/tickets'

const IMPL_HEADER = 'Implementation stage for issue #12. Run your pipeline stage for #12. Follow your Pre-flight, Label swap, Work, and Handoff steps exactly.'
const SOURCE = '/home/u/.claude/plugins/cache/port/port/1.0.0'

describe('stage mode', () => {
  it.each([
    ['plan', queuedAt('new'), 'fresh'],
    ['plan', queuedAt('changes-requested'), 'revision'],
    ['implement', queuedAt('new'), 'implement'],
    ['implement', queuedAt('retry'), 'implement'],
    ['review', queuedAt('new'), 'review'],
    ['merge', { kind: 'waiting-on-you', gate: 'merge', detail: '' }, 'review'],
    ['revise', queuedAt('changes-requested'), 'revise'],
    ['refresh', queuedAt('new'), 'refresh'],
  ] as const)('maps a %s ticket %j to %s', (stage, status, mode) => {
    expect(stageModeOf(ticketViewOf(ticketAt(stage, status)))).toBe(mode)
  })
})

function system(params: { context?: readonly (readonly [string, string])[]; instructions: string; source: string }): string {
  return composeStageSystemPrompt({ context: params.context ?? [], instructions: params.instructions, source: params.source })
}

describe('compose and parse', () => {
  it('round-trips the header, source and multi-paragraph instructions through the saved system prompt', () => {
    const prompt = system({ context: [['stage', 'impl'], ['mode', 'implement']], instructions: 'You are the agent.\n\nSecond paragraph.', source: SOURCE })
    expect(prompt.startsWith(`${STAGE_SYSTEM_PREAMBLE}\n\n<port-stage-context>\nstage: impl\nmode: implement\n</port-stage-context>`)).toBe(true)
    expect(parseStagePrompt(withStageInstructions(IMPL_HEADER, prompt))).toEqual({ stage: 'impl', kind: 'issue', number: 12, instructions: 'You are the agent.\n\nSecond paragraph.', source: SOURCE })
  })

  it('leaves a first message that already carries its instructions alone', () => {
    const old = `${IMPL_HEADER}\n\n<port-stage-instructions source="/old">\nold body\n</port-stage-instructions>`
    expect(withStageInstructions(old, system({ instructions: 'new body', source: '/new' }))).toBe(old)
  })

  it('leaves text that is not a dispatch line alone', () => {
    expect(withStageInstructions('Add a loading state.', system({ instructions: 'x', source: '/p' }))).toBe('Add a loading state.')
  })

  it('parses a bare dispatch one-liner with no instructions', () => {
    expect(parseStagePrompt(IMPL_HEADER)).toEqual({ stage: 'impl', kind: 'issue', number: 12, instructions: null, source: null })
  })

  it('reads a truncated text with no closing tag to its end', () => {
    const full = withStageInstructions(IMPL_HEADER, system({ context: [['stage', 'impl']], instructions: 'one two three', source: '/p' }))
    const cut = full.slice(0, full.indexOf('three') + 3)
    expect(parseStagePrompt(cut)).toEqual({ stage: 'impl', kind: 'issue', number: 12, instructions: 'one two thr', source: '/p' })
  })

  it('does not match text that merely mentions a stage', () => {
    expect(parseStagePrompt('Please explain the Plan stage for issue #5 to me.')).toBeNull()
    expect(parseStagePrompt('Add a loading state to the repositories table.')).toBeNull()
    expect(parseStagePrompt('')).toBeNull()
  })

  it('keeps a quote in the source from breaking the attribute', () => {
    const text = withStageInstructions(IMPL_HEADER, system({ instructions: 'x', source: '/a"b' }))
    expect(parseStagePrompt(text)?.source).toBe("/a'b")
  })
})
