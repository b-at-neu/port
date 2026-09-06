import { describe, expect, it } from 'vitest'
import { closingReference, sessionRequiredAt, SESSION_REQUIRED_PREFIX } from './link'

describe('closingReference', () => {
  it.each(['Closes #79', 'closes #79', 'Fixes #79', 'resolves #79'])('links on %s', (line) => {
    expect(closingReference(`Some intro.\n\n${line}\n\nMore body.`)).toBe(79)
  })

  it('a bare #79 mention with no closing keyword does not link', () => {
    expect(closingReference('See #79 for context.')).toBeNull()
  })

  it('#0 does not link', () => {
    expect(closingReference('Closes #0')).toBeNull()
  })

  it('a second Closes further down does not override the first', () => {
    expect(closingReference('Closes #10\n\nAlso closes #20')).toBe(10)
  })
})

describe('sessionRequiredAt', () => {
  const CANONICAL = `${SESSION_REQUIRED_PREFIX}touches \`.claude/**\` — a dispatched agent can't edit those`

  it('detects the canonical rendering at the issue slot, directly under ## Implementation Plan', () => {
    const body = ['A ticket body.', '', '---', '', '## Implementation Plan', '', CANONICAL, '', '## Overview', 'text'].join('\n')
    expect(sessionRequiredAt(body, 'issue')).toBe(true)
  })

  it('detects the canonical rendering at the pull request slot, directly under Closes #N', () => {
    const body = ['Closes #79', '', CANONICAL, '', '## Summary', 'text'].join('\n')
    expect(sessionRequiredAt(body, 'pull-request')).toBe(true)
  })

  it('does not detect the same rendering three lines lower than the slot', () => {
    const body = ['---', '', '## Implementation Plan', '', '## Overview', '', 'some text', '', CANONICAL].join('\n')
    expect(sessionRequiredAt(body, 'issue')).toBe(false)
  })

  it('does not detect the rendering inside inline code', () => {
    const body = ['---', '', '## Implementation Plan', '', `\`${CANONICAL}\``].join('\n')
    expect(sessionRequiredAt(body, 'issue')).toBe(false)
  })

  it('does not detect an empty reason', () => {
    const body = ['---', '', '## Implementation Plan', '', SESSION_REQUIRED_PREFIX].join('\n')
    expect(sessionRequiredAt(body, 'issue')).toBe(false)
  })

  // This repository's own issue #79 (this very ticket): its plan block's
  // first non-empty line under `## Implementation Plan` is `## Overview`,
  // never the marker — even though the plan's prose discusses
  // `SESSION REQUIRED` at length further down. A real, unmodified fixture
  // for "discusses the marker but does not carry it at the slot".
  it('a body with no ## Implementation Plan and no Closes is not detected (this repository\'s own #61)', () => {
    const body = [
      'The cockpit types `port.config.json` **key** names into `gh --label` filters instead of the label names those keys resolve to.',
      'Because `gh issue list --label <unknown>` returns `[]` with exit code 0 — no error, no warning — every affected query reports "nothing here" forever.',
      '',
      '## Observed',
      '',
      'First tick of a `/port:pipeline` session against this repository.',
    ].join('\n')
    expect(sessionRequiredAt(body, 'issue')).toBe(false)
    expect(sessionRequiredAt(body, 'pull-request')).toBe(false)
  })

  it('this repository\'s own #79 plan discusses the marker in prose but never carries it at the slot', () => {
    const body = [
      'The spine. Merge the three adapters into one per-item view that every later epic reads.',
      '',
      '---',
      '',
      '## Implementation Plan',
      '',
      '## Overview',
      '',
      '`apps/desktop/src/main/state/` is the spine.',
      '',
      'A `SESSION REQUIRED` ticket runs stages 2 and 4 in the operator\'s own `/port:implement` session.',
    ].join('\n')
    expect(sessionRequiredAt(body, 'issue')).toBe(false)
  })
})
