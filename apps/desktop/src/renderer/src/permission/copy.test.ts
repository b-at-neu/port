import { describe, expect, it } from 'vitest'
import { blockedPathLine, contextLine, decisionReasonLine, documentTitle, formatInput, grantLines, grantSummaryLine, headingText, OTHER_SESSION_LINE, primaryLine } from './copy'
import type { PendingPermission } from '../../../shared/hosting/types'

function permission(overrides: Partial<PendingPermission> = {}): PendingPermission {
  return {
    permissionId: 'perm-1',
    toolName: 'Bash',
    input: { command: 'ls' },
    title: null,
    displayName: null,
    description: null,
    decisionReason: null,
    blockedPath: null,
    agentId: null,
    requestedAt: '2026-01-01T00:00:00.000Z',
    sessionGrant: null,
    interaction: null,
    ...overrides,
  }
}

describe('headingText', () => {
  it('uses title when present', () => {
    expect(headingText(permission({ title: 'Claude wants to read foo.txt' }))).toBe('Claude wants to read foo.txt')
  })

  it('falls back to displayName over toolName', () => {
    expect(headingText(permission({ displayName: 'Read file' }))).toBe('Claude wants to use Read file')
  })

  it('falls back to toolName when neither title nor displayName is set', () => {
    expect(headingText(permission({ toolName: 'Bash' }))).toBe('Claude wants to use Bash')
  })
})

describe('contextLine', () => {
  it('names the session label and started time alone for one request, no subagent', () => {
    expect(contextLine('acme/widgets · New session', '14:02', null, 1, 1)).toBe('acme/widgets · New session · started 14:02')
  })

  it('adds the subagent segment when present', () => {
    expect(contextLine('acme/widgets · New session', '14:02', 'agent-9', 1, 1)).toBe('acme/widgets · New session · started 14:02 · subagent agent-9')
  })

  it('adds the waiting counter only once more than one request is queued', () => {
    expect(contextLine('acme/widgets · New session', '14:02', null, 1, 2)).toBe('acme/widgets · New session · started 14:02 · 1 of 2 waiting')
  })

  it('orders subagent before the waiting counter', () => {
    expect(contextLine('acme/widgets · New session', '14:02', 'agent-9', 2, 3)).toBe('acme/widgets · New session · started 14:02 · subagent agent-9 · 2 of 3 waiting')
  })
})

describe('OTHER_SESSION_LINE', () => {
  it('names the different-session warning', () => {
    expect(OTHER_SESSION_LINE).toContain('different session')
  })
})

describe('decisionReasonLine / blockedPathLine', () => {
  it('render their prefix verbatim', () => {
    expect(decisionReasonLine('outside allowed directories')).toBe("Why you're being asked: outside allowed directories")
    expect(blockedPathLine('/etc')).toBe('Outside the allowed directories: /etc')
  })
})

describe('primaryLine', () => {
  it('Bash reads command', () => {
    expect(primaryLine('Bash', { command: 'touch x' })).toBe('touch x')
  })

  it('Read/Write/Edit/MultiEdit/NotebookEdit read file_path', () => {
    for (const tool of ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      expect(primaryLine(tool, { file_path: '/repo/x.ts' })).toBe('/repo/x.ts')
    }
  })

  it('NotebookEdit falls back to notebook_path when file_path is absent', () => {
    expect(primaryLine('NotebookEdit', { notebook_path: '/repo/x.ipynb' })).toBe('/repo/x.ipynb')
  })

  it('WebFetch reads url, WebSearch reads query', () => {
    expect(primaryLine('WebFetch', { url: 'https://example.com' })).toBe('https://example.com')
    expect(primaryLine('WebSearch', { query: 'port pipeline' })).toBe('port pipeline')
  })

  it('Glob and Grep read pattern', () => {
    expect(primaryLine('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
    expect(primaryLine('Grep', { pattern: 'TODO' })).toBe('TODO')
  })

  it('any other tool returns null', () => {
    expect(primaryLine('CustomMcpTool', { anything: 'x' })).toBeNull()
  })

  it('a missing or non-string field returns null', () => {
    expect(primaryLine('Bash', {})).toBeNull()
    expect(primaryLine('Bash', { command: 42 })).toBeNull()
  })
})

describe('formatInput', () => {
  it('pretty-prints with JSON.stringify(input, null, 2)', () => {
    const result = formatInput({ command: 'ls' })
    expect(result).toEqual({ ok: true, text: JSON.stringify({ command: 'ls' }, null, 2) })
  })

  it('reports ok: false when stringify throws (a circular structure)', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(formatInput(circular)).toEqual({ ok: false })
  })
})

describe('grantLines / grantSummaryLine', () => {
  it('a rule with content renders as tool(content)', () => {
    expect(grantLines([{ kind: 'rule', toolName: 'Bash', ruleContent: 'npm test:*' }])).toEqual(['Bash(npm test:*)'])
  })

  it('a rule with no content renders as "tool — every call"', () => {
    expect(grantLines([{ kind: 'rule', toolName: 'WebSearch', ruleContent: null }])).toEqual(['WebSearch — every call'])
  })

  it('a directory renders as "Access to <path>"', () => {
    expect(grantLines([{ kind: 'directory', path: '/home/operator/Downloads' }])).toEqual(['Access to /home/operator/Downloads'])
  })

  it('accept-edits renders as "Every file edit"', () => {
    expect(grantLines([{ kind: 'accept-edits' }])).toEqual(['Every file edit'])
  })

  it('grantSummaryLine joins every line under one prefix', () => {
    expect(grantSummaryLine([{ kind: 'rule', toolName: 'Bash', ruleContent: 'npm test:*' }, { kind: 'accept-edits' }])).toBe(
      'Also allows, until this session ends: Bash(npm test:*), Every file edit',
    )
  })
})

describe('documentTitle', () => {
  it('is "port" when the queue is empty', () => {
    expect(documentTitle(0)).toBe('port')
  })

  it('singular for exactly one', () => {
    expect(documentTitle(1)).toBe('port — 1 permission request waiting')
  })

  it('plural for more than one', () => {
    expect(documentTitle(2)).toBe('port — 2 permission requests waiting')
  })
})
