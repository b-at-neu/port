import { describe, expect, it } from 'vitest'
import { classifyFinalMessage, relayPayloadOf } from './classify'

describe('classifyFinalMessage', () => {
  it('classifies a numbered QUESTIONS FOR HUMAN: block as questions', () => {
    const text = ['Ran into an ambiguity.', '', 'QUESTIONS FOR HUMAN:', '1. Which branch is base?', '2. Should I rename the file?'].join('\n')
    expect(classifyFinalMessage(text)).toBe('questions')
  })

  it('classifies a BLOCKED: line as blocked', () => {
    const text = 'BLOCKED: the ci token is missing, need it rotated'
    expect(classifyFinalMessage(text)).toBe('blocked')
  })

  it('classifies plain completion prose as completed', () => {
    expect(classifyFinalMessage('Opened PR #42 and pushed the branch.')).toBe('completed')
  })

  it('classifies a message that only discusses the marker, with no numbered lines, as completed', () => {
    const text = 'This ticket documents the QUESTIONS FOR HUMAN: convention but poses none itself.'
    expect(classifyFinalMessage(text)).toBe('completed')
  })

  it('never matches a marker quoted inside a fenced code block', () => {
    const text = ['Here is the convention:', '```', 'QUESTIONS FOR HUMAN:', '1. example', '```', 'Nothing pending.'].join('\n')
    expect(classifyFinalMessage(text)).toBe('completed')
  })

  it('never matches a marker quoted inside an inline code span', () => {
    const text = 'Emit `BLOCKED: <reason>` when a command is denied.'
    expect(classifyFinalMessage(text)).toBe('completed')
  })

  it('never matches a marker that is not at the start of a line', () => {
    const text = 'The agent wrote BLOCKED: right here mid-sentence.'
    expect(classifyFinalMessage(text)).toBe('completed')
  })

  it('classifies the usage-limit phrase only when neither marker matched', () => {
    const text = "You've hit your session limit · resets 4:10pm (America/New_York)"
    expect(classifyFinalMessage(text)).toBe('usage-limit')
  })

  it('prefers the blocked marker over an incidental usage-limit phrase', () => {
    const text = 'BLOCKED: dispatch failed after a session limit reset; need a decision.'
    expect(classifyFinalMessage(text)).toBe('blocked')
  })
})

describe('relayPayloadOf', () => {
  it('parses ordered numbered questions', () => {
    const text = ['QUESTIONS FOR HUMAN:', '1. Which branch is base?', '2. Should I rename the file?'].join('\n')
    expect(relayPayloadOf(text, 'questions')).toEqual({
      kind: 'questions',
      questions: [
        { index: 0, text: 'Which branch is base?' },
        { index: 1, text: 'Should I rename the file?' },
      ],
    })
  })

  it('parses the blocked request from the rest of the marker line plus every following line', () => {
    const text = ['BLOCKED: the ci token is missing.', 'Need it rotated before I can push.'].join('\n')
    expect(relayPayloadOf(text, 'blocked')).toEqual({
      kind: 'blocked',
      request: 'the ci token is missing.\nNeed it rotated before I can push.',
    })
  })

  it('carries no payload for usage-limit', () => {
    expect(relayPayloadOf('anything', 'usage-limit')).toEqual({ kind: 'usage-limit' })
  })
})
