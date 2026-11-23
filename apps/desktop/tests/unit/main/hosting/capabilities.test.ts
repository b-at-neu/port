import { describe, expect, it, vi } from 'vitest'
import { createCapabilityTracker as createTracker } from '@/main/hosting/capabilities'
import type { HostedQuery } from '@/main/platform/sdk'

function createCapabilityTracker(params: Omit<Parameters<typeof createTracker>[0], 'stage'> & { readonly stage?: boolean }): ReturnType<typeof createTracker> {
  return createTracker({ stage: false, ...params })
}

function fakeQuery(commands: unknown[], agents: unknown[]): HostedQuery {
  return {
    supportedCommands: () => Promise.resolve(commands),
    supportedAgents: () => Promise.resolve(agents),
    interrupt: () => Promise.resolve(undefined),
    close: () => undefined,
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<unknown>>(() => undefined) }
    },
  } as unknown as HostedQuery
}

const PIPELINE_COMMAND = { name: 'port:pipeline', description: 'Cockpit', argumentHint: '' }
const SCOPE_COMMAND = { name: 'port:scope', description: 'Scope\u0007 a feature', argumentHint: '<feature description>' }
const NON_PORT_COMMAND = { name: 'other:cmd', description: 'Not ours', argumentHint: '' }
const UNQUALIFIED_PIPELINE = { name: 'pipeline', description: "The repository's own command", argumentHint: '' }
const PLAN_AGENT = { name: 'port:plan-agent', description: 'Plans', model: 'opus' }

describe('createCapabilityTracker', () => {
  it('starts pending', () => {
    expect(createCapabilityTracker({ onChange: vi.fn() }).current()).toEqual({ kind: 'pending' })
  })

  it('reaches ready with only port: commands and agents, sorted by name and sanitized — pipeline dropped from both command lists', async () => {
    const onChange = vi.fn()
    const tracker = createCapabilityTracker({ onChange })
    await tracker.start(fakeQuery([SCOPE_COMMAND, PIPELINE_COMMAND, NON_PORT_COMMAND], [PLAN_AGENT]))

    const state = tracker.current()
    expect(state.kind).toBe('ready')
    if (state.kind !== 'ready') return
    expect(state.commands.map((c) => c.name)).toEqual(['scope'])
    expect(state.commands.find((c) => c.name === 'scope')?.description).toBe('Scope a feature')
    expect(state.agents).toEqual([{ name: 'plan-agent', description: 'Plans', model: 'opus' }])
    expect(state.plugin).toEqual({ kind: 'unconfirmed' })
    expect(onChange).toHaveBeenCalled()
  })

  it('slashCommands carries every reported command, namespace intact, with pipeline dropped', async () => {
    const tracker = createCapabilityTracker({ onChange: vi.fn() })
    await tracker.start(fakeQuery([SCOPE_COMMAND, PIPELINE_COMMAND, NON_PORT_COMMAND], []))

    const state = tracker.current()
    expect(state.kind).toBe('ready')
    if (state.kind !== 'ready') return
    expect(state.slashCommands.map((c) => c.name)).toEqual(['other:cmd', 'port:scope'])
  })

  it('slashCommands keeps a bare pipeline command when the session reports it as its own, unqualified', async () => {
    const tracker = createCapabilityTracker({ onChange: vi.fn() })
    await tracker.start(fakeQuery([UNQUALIFIED_PIPELINE, PIPELINE_COMMAND], []))

    const state = tracker.current()
    expect(state.kind).toBe('ready')
    if (state.kind !== 'ready') return
    expect(state.slashCommands.map((c) => c.name)).toEqual(['pipeline'])
  })

  it('has() reports membership by the namespace-stripped name, never true for pipeline', async () => {
    const tracker = createCapabilityTracker({ onChange: vi.fn() })
    await tracker.start(fakeQuery([SCOPE_COMMAND, PIPELINE_COMMAND], []))
    expect(tracker.has('scope')).toBe(true)
    expect(tracker.has('pipeline')).toBe(false)
    expect(tracker.has('nope')).toBe(false)
  })

  it('goes unavailable, message verbatim, when supportedCommands rejects — never an empty list', async () => {
    const query = {
      supportedCommands: () => Promise.reject(new Error('the CLI hung up')),
      supportedAgents: () => Promise.resolve([]),
      interrupt: () => Promise.resolve(undefined),
      close: () => undefined,
      [Symbol.asyncIterator]() {
        return { next: () => new Promise<IteratorResult<unknown>>(() => undefined) }
      },
    } as unknown as HostedQuery
    const tracker = createCapabilityTracker({ onChange: vi.fn() })
    await tracker.start(query)
    expect(tracker.current()).toEqual({ kind: 'unavailable', message: 'the CLI hung up' })
  })

  it('goes unavailable on a timeout, never a silently empty list', async () => {
    const hangingQuery = {
      supportedCommands: () => new Promise<never>(() => undefined),
      supportedAgents: () => new Promise<never>(() => undefined),
      interrupt: () => Promise.resolve(undefined),
      close: () => undefined,
      [Symbol.asyncIterator]() {
        return { next: () => new Promise<IteratorResult<unknown>>(() => undefined) }
      },
    } as unknown as HostedQuery
    const tracker = createCapabilityTracker({ onChange: vi.fn(), timeoutMs: 10 })
    await tracker.start(hangingQuery)
    expect(tracker.current().kind).toBe('unavailable')
  })

  it('observe(init) resolves the plugin load', async () => {
    const onChange = vi.fn()
    const tracker = createCapabilityTracker({ onChange })
    await tracker.start(fakeQuery([SCOPE_COMMAND], []))
    onChange.mockClear()

    tracker.observe({ type: 'system', subtype: 'init', plugins: [{ name: 'port', path: '/home/op/.claude/plugins/cache/port', version: '0.3.1' }] })

    const state = tracker.current()
    expect(state.kind).toBe('ready')
    if (state.kind !== 'ready') return
    expect(state.plugin).toEqual({ kind: 'loaded', path: '/home/op/.claude/plugins/cache/port', version: '0.3.1' })
    expect(onChange).toHaveBeenCalled()
  })

  it('observe(commands_changed) replaces the command list', async () => {
    const tracker = createCapabilityTracker({ onChange: vi.fn() })
    await tracker.start(fakeQuery([], []))

    tracker.observe({ type: 'system', subtype: 'commands_changed', commands: [SCOPE_COMMAND] })

    const state = tracker.current()
    expect(state.kind).toBe('ready')
    if (state.kind !== 'ready') return
    expect(state.commands.map((c) => c.name)).toEqual(['scope'])
  })

  describe('in a stage session', () => {
    const RELEASE_COMMAND = { name: 'port:release', description: 'Release', argumentHint: '' }

    function stageTracker() {
      return createCapabilityTracker({ onChange: vi.fn(), stage: true })
    }

    it('exposes no commands, no port: autocomplete entries, and refuses has()', async () => {
      const tracker = stageTracker()
      await tracker.start(fakeQuery([SCOPE_COMMAND, RELEASE_COMMAND, PIPELINE_COMMAND, NON_PORT_COMMAND], []))
      const state = tracker.current()
      expect(state.kind).toBe('ready')
      if (state.kind !== 'ready') return
      expect(state.commands).toEqual([])
      expect(state.slashCommands.map((c) => c.name)).toEqual(['other:cmd'])
      expect(tracker.has('scope')).toBe(false)
    })

    it('holds all of it after commands_changed', async () => {
      const tracker = stageTracker()
      await tracker.start(fakeQuery([], []))
      tracker.observe({ type: 'system', subtype: 'commands_changed', commands: [SCOPE_COMMAND, RELEASE_COMMAND, NON_PORT_COMMAND] })
      const state = tracker.current()
      expect(state.kind).toBe('ready')
      if (state.kind !== 'ready') return
      expect(state.commands).toEqual([])
      expect(state.slashCommands.map((c) => c.name)).toEqual(['other:cmd'])
      expect(tracker.has('scope')).toBe(false)
    })

    it('isBlocked refuses port commands, qualified or reported-bare, and allows the rest', async () => {
      const tracker = stageTracker()
      await tracker.start(fakeQuery([SCOPE_COMMAND, NON_PORT_COMMAND], []))
      expect(tracker.isBlocked('port:scope')).toBe(true)
      expect(tracker.isBlocked('scope')).toBe(true)
      expect(tracker.isBlocked('other:cmd')).toBe(false)
    })
  })

  it('isBlocked in an interactive session refuses only pipeline', async () => {
    const tracker = createCapabilityTracker({ onChange: vi.fn() })
    await tracker.start(fakeQuery([SCOPE_COMMAND, PIPELINE_COMMAND], []))
    expect(tracker.isBlocked('port:pipeline')).toBe(true)
    expect(tracker.isBlocked('pipeline')).toBe(true)
    expect(tracker.isBlocked('port:scope')).toBe(false)
    expect(tracker.isBlocked('scope')).toBe(false)
  })

  it('isBlocked lets a bare pipeline through when the session reports one of its own', async () => {
    const tracker = createCapabilityTracker({ onChange: vi.fn() })
    await tracker.start(fakeQuery([UNQUALIFIED_PIPELINE, PIPELINE_COMMAND], []))
    expect(tracker.isBlocked('pipeline')).toBe(false)
    expect(tracker.isBlocked('port:pipeline')).toBe(true)
  })

  it('observe() ignores anything but system/init and system/commands_changed', async () => {
    const onChange = vi.fn()
    const tracker = createCapabilityTracker({ onChange })
    await tracker.start(fakeQuery([], []))
    onChange.mockClear()
    tracker.observe({ type: 'assistant', message: {} })
    tracker.observe(null)
    tracker.observe('not an object')
    expect(onChange).not.toHaveBeenCalled()
  })
})
