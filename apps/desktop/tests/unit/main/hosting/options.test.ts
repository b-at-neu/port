import { describe, expect, it, vi } from 'vitest'
import { GUARD_ALLOWLIST_MISS_MARKER } from '@/main/hosting/guard-marker'
import { ISSUE_BODY_GUARD_MESSAGE, LABEL_GUARD_MESSAGE } from '@/main/hosting/label-guard'
import { buildSessionOptions } from '@/main/hosting/options'
import type { CanUseTool } from '@/main/hosting/sdk'
import { DEFAULT_SESSION_DEFAULTS } from '@/types/hosting'
import type { PluginRequest } from '@/types/hosting-plugin'

const canUseTool = vi.fn() as unknown as CanUseTool
const INSTALLED: PluginRequest = { source: 'installed' }
const REPOSITORY: PluginRequest = { source: 'repository', path: '/repo/plugins/port' }
const BASE = { cwd: '/repo', executablePath: '/home/operator/.local/bin/claude', canUseTool, plugin: INSTALLED, defaults: DEFAULT_SESSION_DEFAULTS, stage: null }

describe('buildSessionOptions', () => {
  it('every mode carries the shared constants', () => {
    const options = buildSessionOptions({ ...BASE, mode: { kind: 'fresh' } })
    expect(options.cwd).toBe('/repo')
    expect(options.pathToClaudeCodeExecutable).toBe('/home/operator/.local/bin/claude')
    expect(options.persistSession).toBe(true)
    expect(options.includePartialMessages).toBe(true)
    expect(options.permissionMode).toBe('default')
    expect(options.canUseTool).toBe(canUseTool)
    expect(options.permissionPromptToolName).toBeUndefined()
  })

  it('fresh carries no resume-shaped field', () => {
    const options = buildSessionOptions({ ...BASE, mode: { kind: 'fresh' } })
    expect(options.resume).toBeUndefined()
    expect(options.forkSession).toBeUndefined()
    expect(options.resumeSessionAt).toBeUndefined()
  })

  it('resume carries resume alone', () => {
    const options = buildSessionOptions({ ...BASE, mode: { kind: 'resume', sessionId: 'abc' } })
    expect(options.resume).toBe('abc')
    expect(options.forkSession).toBeUndefined()
    expect(options.resumeSessionAt).toBeUndefined()
  })

  it('resume-at carries resume and resumeSessionAt, and resumeDropsTurn only when given', () => {
    const withoutDrop = buildSessionOptions({ ...BASE, mode: { kind: 'resume-at', sessionId: 'abc', messageUuid: 'msg-1', resumeDropsTurn: null } })
    expect(withoutDrop.resume).toBe('abc')
    expect(withoutDrop.resumeSessionAt).toBe('msg-1')
    expect(withoutDrop.resumeDropsTurn).toBeUndefined()

    const withDrop = buildSessionOptions({ ...BASE, mode: { kind: 'resume-at', sessionId: 'abc', messageUuid: 'msg-1', resumeDropsTurn: 'turn-1' } })
    expect(withDrop.resumeDropsTurn).toBe('turn-1')
  })

  it('fork carries resume and forkSession: true', () => {
    const options = buildSessionOptions({ ...BASE, mode: { kind: 'fork', sessionId: 'parent-id' } })
    expect(options.resume).toBe('parent-id')
    expect(options.forkSession).toBe(true)
  })

  it('sessionId is never passed for any mode — the init message is the only source', () => {
    for (const mode of [
      { kind: 'fresh' as const },
      { kind: 'resume' as const, sessionId: 'x' },
      { kind: 'resume-at' as const, sessionId: 'x', messageUuid: 'y', resumeDropsTurn: null },
      { kind: 'fork' as const, sessionId: 'x' },
    ]) {
      const options = buildSessionOptions({ ...BASE, mode })
      expect(options.sessionId).toBeUndefined()
    }
  })

  const MODES = [
    { kind: 'fresh' as const },
    { kind: 'resume' as const, sessionId: 'x' },
    { kind: 'resume-at' as const, sessionId: 'x', messageUuid: 'y', resumeDropsTurn: null },
    { kind: 'fork' as const, sessionId: 'x' },
  ]

  it('the installed source passes no plugins option, in every start mode', () => {
    for (const mode of MODES) {
      const options = buildSessionOptions({ ...BASE, mode, plugin: INSTALLED })
      expect(options.plugins).toBeUndefined()
    }
  })

  it('the repository source passes one local plugin entry at its own path, in every start mode', () => {
    for (const mode of MODES) {
      const options = buildSessionOptions({ ...BASE, mode, plugin: REPOSITORY })
      expect(options.plugins).toEqual([{ type: 'local', path: '/repo/plugins/port' }])
    }
  })
})

describe('buildSessionOptions — operator session defaults (#364)', () => {
  it("the operator role reads permissionMode from defaults, never a bare 'default'", () => {
    const options = buildSessionOptions({ ...BASE, mode: { kind: 'fresh' }, defaults: { model: null, permissionMode: 'acceptEdits' } })
    expect(options.permissionMode).toBe('acceptEdits')
  })

  it('model is set only when defaults.model is non-null', () => {
    const withNull = buildSessionOptions({ ...BASE, mode: { kind: 'fresh' }, defaults: { model: null, permissionMode: 'default' } })
    expect(withNull.model).toBeUndefined()

    const withModel = buildSessionOptions({ ...BASE, mode: { kind: 'fresh' }, defaults: { model: 'opus', permissionMode: 'default' } })
    expect(withModel.model).toBe('opus')
  })
})

describe('buildSessionOptions — stage branch (#327)', () => {
  const IMPL = { name: 'impl-agent', definition: { description: 'impl', prompt: 'body', disallowedTools: ['Agent'] } }

  it('sets agent, model and permissionMode: default from stage, never reading defaults', () => {
    const options = buildSessionOptions({ ...BASE, mode: { kind: 'fresh' }, defaults: { model: 'haiku', permissionMode: 'acceptEdits' }, stage: { agent: IMPL, instructionsRoot: '/bundle', model: 'sonnet' } })
    expect(options.permissionMode).toBe('default')
    expect(options.model).toBe('sonnet')
    expect(options.agent).toBe('impl-agent')
  })

  it('defines the agent inline with the stage model and reads the bundle through additionalDirectories', () => {
    const options = buildSessionOptions({ ...BASE, mode: { kind: 'fresh' }, stage: { agent: IMPL, instructionsRoot: '/bundle', model: 'sonnet' } })
    expect(options.agents).toEqual({ 'impl-agent': { description: 'impl', prompt: 'body', disallowedTools: ['Agent'], model: 'sonnet' } })
    expect(options.additionalDirectories).toEqual(['/bundle'])
  })

  it('adds no allowedTools or systemPrompt', () => {
    const options = buildSessionOptions({ ...BASE, mode: { kind: 'fresh' }, stage: { agent: { name: 'plan-agent', definition: { description: 'plan', prompt: 'body' } }, instructionsRoot: '/bundle', model: 'opus' } }) as Record<string, unknown>
    expect(options['allowedTools']).toBeUndefined()
    expect(options['systemPrompt']).toBeUndefined()
  })

  describe('label guard hook', () => {
    const STAGE = { agent: IMPL, instructionsRoot: '/bundle', model: 'sonnet' }
    const SIGNAL = { signal: new AbortController().signal }
    const bashInput = (command: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 't' }) as never

    function guard() {
      const options = buildSessionOptions({ ...BASE, mode: { kind: 'fresh' }, stage: STAGE })
      const matcher = options.hooks?.PreToolUse?.[0]
      const hook = matcher?.hooks[0]
      if (matcher === undefined || hook === undefined) throw new Error('no PreToolUse hook on the stage session')
      return { matcher, hook }
    }

    it('a stage session carries one PreToolUse hook on Bash', () => {
      const options = buildSessionOptions({ ...BASE, mode: { kind: 'fresh' }, stage: STAGE })
      expect(options.hooks?.PreToolUse).toHaveLength(1)
      expect(guard().matcher.matcher).toBe('Bash')
    })

    it('an operator session carries no hooks', () => {
      expect(buildSessionOptions({ ...BASE, mode: { kind: 'fresh' } }).hooks).toBeUndefined()
    })

    it('denies a label write with the reason the agent sees', async () => {
      const result = await guard().hook(bashInput('gh issue edit 52 --repo o/a --add-label planning'), 't', SIGNAL)
      expect(result).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: LABEL_GUARD_MESSAGE } })
    })

    it.each(['gh issue edit 52 --repo o/a --body-file .temp/plan-52.md', 'gh api repos/o/a/issues/52 -X PATCH -F body=@.temp/p.md'])('denies an issue-body write with its own reason: %s', async (command) => {
      const result = await guard().hook(bashInput(command), 't', SIGNAL)
      expect(result).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: ISSUE_BODY_GUARD_MESSAGE } })
    })

    it('a command that is both a label and a body write gets the label reason', async () => {
      const result = await guard().hook(bashInput('gh issue edit 52 --add-label x --body-file .temp/p.md'), 't', SIGNAL)
      expect(result).toMatchObject({ hookSpecificOutput: { permissionDecisionReason: LABEL_GUARD_MESSAGE } })
    })

    it('lets a comment and a pull request description through', async () => {
      expect(await guard().hook(bashInput('gh issue comment 52 --body-file .temp/b.md'), 't', SIGNAL)).toEqual({})
      expect(await guard().hook(bashInput('gh pr edit 8 --body-file .temp/pr-body-8.md'), 't', SIGNAL)).toEqual({})
    })

    it('says nothing about a command that reads labels or writes none', async () => {
      expect(await guard().hook(bashInput('gh pr view 8 --repo o/a --json labels'), 't', SIGNAL)).toEqual({})
      expect(await guard().hook(bashInput('git status'), 't', SIGNAL)).toEqual({})
    })

    it('ignores a non-Bash tool and an input with no command', async () => {
      expect(await guard().hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, tool_use_id: 't' } as never, 't', SIGNAL)).toEqual({})
      expect(await guard().hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: null, tool_use_id: 't' } as never, 't', SIGNAL)).toEqual({})
    })

    it('never uses the allowlist-miss reason, so a denial never becomes an Allow item', () => {
      expect(LABEL_GUARD_MESSAGE).not.toContain(GUARD_ALLOWLIST_MISS_MARKER)
      expect(ISSUE_BODY_GUARD_MESSAGE).not.toContain(GUARD_ALLOWLIST_MISS_MARKER)
    })
  })
})
