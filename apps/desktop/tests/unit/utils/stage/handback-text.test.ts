import { describe, expect, it } from 'vitest'
import { classifyHandbackText } from '@/utils/stage/handback-text'

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
