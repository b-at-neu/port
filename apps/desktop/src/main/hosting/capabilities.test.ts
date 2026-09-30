import { describe, expect, it, vi } from 'vitest'
import { createCapabilityTracker } from './capabilities'
import type { PluginRequest } from '../../shared/hosting/types'
import type { HostedQuery } from './sdk'

const INSTALLED: PluginRequest = { source: 'installed' }
const REPOSITORY: PluginRequest = { source: 'repository', path: '/repo/plugins/port' }
const samePath = (a: string, b: string) => a === b

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
const PLAN_AGENT = { name: 'port:plan-agent', description: 'Plans', model: 'opus' }

describe('createCapabilityTracker', () => {
  it('starts pending, naming the request', () => {
    const tracker = createCapabilityTracker({ request: INSTALLED, readExpectedComponents: () => Promise.resolve(null), samePath, onChange: vi.fn() })
    expect(tracker.current()).toEqual({ kind: 'pending', request: INSTALLED })
  })

  it('reaches ready with only port: commands and agents, sorted by name and sanitized', async () => {
    const onChange = vi.fn()
    const tracker = createCapabilityTracker({ request: INSTALLED, readExpectedComponents: () => Promise.resolve(null), samePath, onChange })
    await tracker.start(fakeQuery([SCOPE_COMMAND, PIPELINE_COMMAND, NON_PORT_COMMAND], [PLAN_AGENT]))

    const state = tracker.current()
    expect(state.kind).toBe('ready')
    if (state.kind !== 'ready') return
    expect(state.commands.map((c) => c.name)).toEqual(['pipeline', 'scope'])
    expect(state.commands.find((c) => c.name === 'scope')?.description).toBe('Scope a feature')
    expect(state.agents).toEqual([{ name: 'plan-agent', description: 'Plans', model: 'opus' }])
    expect(onChange).toHaveBeenCalled()
  })

  it('has() reports membership by the namespace-stripped name', async () => {
    const tracker = createCapabilityTracker({ request: INSTALLED, readExpectedComponents: () => Promise.resolve(null), samePath, onChange: vi.fn() })
    await tracker.start(fakeQuery([PIPELINE_COMMAND], []))
    expect(tracker.has('pipeline')).toBe(true)
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
    const tracker = createCapabilityTracker({ request: INSTALLED, readExpectedComponents: () => Promise.resolve(null), samePath, onChange: vi.fn() })
    await tracker.start(query)
    expect(tracker.current()).toEqual({ kind: 'unavailable', request: INSTALLED, message: 'the CLI hung up' })
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
    const tracker = createCapabilityTracker({ request: INSTALLED, readExpectedComponents: () => Promise.resolve(null), samePath, onChange: vi.fn(), timeoutMs: 10 })
    await tracker.start(hangingQuery)
    expect(tracker.current().kind).toBe('unavailable')
  })

  it('for the repository source, reads expected components from request.path at start, and reports incomplete', async () => {
    const readExpectedComponents = vi.fn(() => Promise.resolve({ skills: ['pipeline', 'scope'], agents: ['plan-agent'] }))
    const tracker = createCapabilityTracker({ request: REPOSITORY, readExpectedComponents, samePath, onChange: vi.fn() })
    await tracker.start(fakeQuery([PIPELINE_COMMAND], []))
    expect(readExpectedComponents).toHaveBeenCalledWith('/repo/plugins/port')
    const state = tracker.current()
    expect(state.kind).toBe('ready')
    if (state.kind !== 'ready') return
    expect(state.components).toEqual({ kind: 'incomplete', missingSkills: ['scope'], missingAgents: ['plan-agent'] })
  })

  it('observe(init) resolves the plugin load and recomputes components', async () => {
    const onChange = vi.fn()
    const tracker = createCapabilityTracker({
      request: REPOSITORY,
      readExpectedComponents: () => Promise.resolve({ skills: ['pipeline'], agents: [] }),
      samePath,
      onChange,
    })
    await tracker.start(fakeQuery([PIPELINE_COMMAND], []))
    onChange.mockClear()

    tracker.observe({ type: 'system', subtype: 'init', plugins: [{ name: 'port', path: '/repo/plugins/port', version: '0.3.1' }] })

    const state = tracker.current()
    expect(state.kind).toBe('ready')
    if (state.kind !== 'ready') return
    expect(state.plugin).toEqual({ kind: 'loaded', path: '/repo/plugins/port', version: '0.3.1' })
    expect(state.components).toEqual({ kind: 'complete' })
    expect(onChange).toHaveBeenCalled()
  })

  it('for the installed source, reads expected components from the first loaded path reported by init', async () => {
    const readExpectedComponents = vi.fn(() => Promise.resolve({ skills: ['pipeline'], agents: [] }))
    const tracker = createCapabilityTracker({ request: INSTALLED, readExpectedComponents, samePath, onChange: vi.fn() })
    await tracker.start(fakeQuery([PIPELINE_COMMAND], []))
    expect(readExpectedComponents).not.toHaveBeenCalled()

    tracker.observe({ type: 'system', subtype: 'init', plugins: [{ name: 'port', path: '/home/op/.claude/plugins/cache/port', version: '0.3.1' }] })
    await Promise.resolve()
    await Promise.resolve()

    expect(readExpectedComponents).toHaveBeenCalledWith('/home/op/.claude/plugins/cache/port')
  })

  it('observe(commands_changed) replaces the command list and re-runs the component check', async () => {
    const tracker = createCapabilityTracker({
      request: REPOSITORY,
      readExpectedComponents: () => Promise.resolve({ skills: ['pipeline', 'scope'], agents: [] }),
      samePath,
      onChange: vi.fn(),
    })
    await tracker.start(fakeQuery([PIPELINE_COMMAND], []))
    const before = tracker.current()
    expect(before.kind).toBe('ready')
    if (before.kind === 'ready') expect(before.components.kind).toBe('incomplete')

    tracker.observe({ type: 'system', subtype: 'commands_changed', commands: [PIPELINE_COMMAND, SCOPE_COMMAND] })

    const state = tracker.current()
    expect(state.kind).toBe('ready')
    if (state.kind !== 'ready') return
    expect(state.commands.map((c) => c.name)).toEqual(['pipeline', 'scope'])
    expect(state.components).toEqual({ kind: 'complete' })
  })

  it('observe() ignores anything but system/init and system/commands_changed', async () => {
    const onChange = vi.fn()
    const tracker = createCapabilityTracker({ request: INSTALLED, readExpectedComponents: () => Promise.resolve(null), samePath, onChange })
    await tracker.start(fakeQuery([], []))
    onChange.mockClear()
    tracker.observe({ type: 'assistant', message: {} })
    tracker.observe(null)
    tracker.observe('not an object')
    expect(onChange).not.toHaveBeenCalled()
  })
})
