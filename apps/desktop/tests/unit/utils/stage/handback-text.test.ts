import { describe, expect, it } from 'vitest'
import { blockedReasonOf, capHandbackText, classifyHandbackText } from '@/utils/stage/handback-text'

describe('capHandbackText', () => {
  it('keeps text up to 120 characters and truncates beyond with an ellipsis', () => {
    expect(capHandbackText('x'.repeat(120))).toBe('x'.repeat(120))
    expect(capHandbackText('x'.repeat(121))).toBe(`${'x'.repeat(120)}…`)
  })
})

describe('blockedReasonOf', () => {
  it('strips the prefix, trims and caps', () => {
    expect(blockedReasonOf('BLOCKED:   needs a decision  ')).toBe('needs a decision')
    expect(blockedReasonOf(`BLOCKED: ${'y'.repeat(200)}`)).toBe(`${'y'.repeat(120)}…`)
  })
})

describe('classifyHandbackText', () => {
  it('classifies blocked when a preamble precedes the BLOCKED: line', () => {
    const result = classifyHandbackText('Tried the thing first.\nBLOCKED: denied command xyz')
    expect(result).toEqual({ kind: 'blocked', line: 'BLOCKED: denied command xyz' })
  })

  it('returns null when BLOCKED: only appears inside a fenced code block', () => {
    const result = classifyHandbackText('Example output:\n```\nBLOCKED: not a real one\n```\nAll clear.')
    expect(result).toBeNull()
  })

  it('returns null when the questions prefix appears mid-message, not in the last paragraph', () => {
    const result = classifyHandbackText('QUESTIONS FOR HUMAN:\nwhich branch?\n\nNever mind, I figured it out myself.')
    expect(result).toBeNull()
  })

  it('classifies questions when the last paragraph starts with QUESTIONS FOR HUMAN:', () => {
    const result = classifyHandbackText('Some context.\n\nQUESTIONS FOR HUMAN:\n- which branch?')
    expect(result).toEqual({ kind: 'questions' })
  })

  it('returns null for plain text with neither marker', () => {
    expect(classifyHandbackText('All done, pull request opened.')).toBeNull()
  })
})
