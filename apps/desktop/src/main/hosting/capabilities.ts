// A timeout or rejected read-back must never look like an empty capability list.
import type { AgentSummary, CommandSummary, PluginRequest, SessionCapabilities } from '../../shared/hosting/types'
import { isRecord } from '../../shared/guards'
import { sanitize } from '../sessions/transcript-entries'
import { checkComponents, checkPluginLoad, PLUGIN_NAME } from './verify'
import type { InitPlugin } from './verify'
import type { ExpectedComponents } from './plugin'
import type { AgentInfo, HostedQuery, SlashCommand } from './sdk'

/** Control requests answered before the first turn, costing no tokens. */
export const CAPABILITIES_TIMEOUT_MS = 30_000

const QUALIFIER = `${PLUGIN_NAME}:`

export interface CreateCapabilityTrackerParams {
  readonly request: PluginRequest
  readonly readExpectedComponents: (pluginPath: string) => Promise<ExpectedComponents | null>
  readonly samePath: (a: string, b: string) => boolean
  readonly onChange: () => void
  /** Test-only override of `CAPABILITIES_TIMEOUT_MS`. */
  readonly timeoutMs?: number
}

export interface CapabilityTracker {
  start(query: HostedQuery): Promise<void>
  observe(message: unknown): void
  current(): SessionCapabilities
  has(name: string): boolean
}

function isPortQualified(name: string): boolean {
  return name.startsWith(QUALIFIER) && name.length > QUALIFIER.length
}

function toCommandSummaries(raw: readonly SlashCommand[]): CommandSummary[] {
  return raw
    .filter((command) => isPortQualified(command.name))
    .map((command) => ({ name: command.name.slice(QUALIFIER.length), description: sanitize(command.description), argumentHint: command.argumentHint }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function toAgentSummaries(raw: readonly AgentInfo[]): AgentSummary[] {
  return raw
    .filter((agent) => isPortQualified(agent.name))
    .map((agent) => ({ name: agent.name.slice(QUALIFIER.length), description: sanitize(agent.description), model: agent.model ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function timeoutRejection(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    AbortSignal.timeout(ms).addEventListener('abort', () => reject(new Error(`Timed out after ${ms}ms waiting for this session's commands and agents`)), { once: true })
  })
}

function initPluginsOf(message: Record<string, unknown>): readonly InitPlugin[] | null {
  const plugins = message['plugins']
  if (!Array.isArray(plugins)) return null
  return plugins.filter((entry): entry is InitPlugin => isRecord(entry) && typeof entry['name'] === 'string' && typeof entry['path'] === 'string')
}

export function createCapabilityTracker(params: CreateCapabilityTrackerParams): CapabilityTracker {
  let state: SessionCapabilities = { kind: 'pending', request: params.request }
  let expected: ExpectedComponents | null = null
  let expectedRequested = false
  /** Settles only once the read actually finishes, distinct from `expectedRequested`. */
  let expectedSettled = false
  let commands: CommandSummary[] = []
  let agents: AgentSummary[] = []
  let initPlugins: readonly InitPlugin[] | null = null

  function recompute(): void {
    const plugin = checkPluginLoad({ request: params.request, initPlugins, samePath: params.samePath })
    const components = checkComponents({
      expected,
      expectedAttempted: expectedSettled,
      commandNames: commands.map((command) => command.name),
      agentNames: agents.map((agent) => agent.name),
    })
    state = { kind: 'ready', request: params.request, commands, agents, plugin, components }
  }

  async function ensureExpected(pluginPath: string): Promise<void> {
    if (expectedRequested) return
    expectedRequested = true
    expected = await params.readExpectedComponents(pluginPath).catch(() => null)
    expectedSettled = true
  }

  async function start(query: HostedQuery): Promise<void> {
    if (params.request.source === 'repository') await ensureExpected(params.request.path)

    try {
      const [rawCommands, rawAgents] = await Promise.race([Promise.all([query.supportedCommands(), query.supportedAgents()]), timeoutRejection(params.timeoutMs ?? CAPABILITIES_TIMEOUT_MS)])
      commands = toCommandSummaries(rawCommands)
      agents = toAgentSummaries(rawAgents)
      recompute()
    } catch (error) {
      state = { kind: 'unavailable', request: params.request, message: error instanceof Error ? error.message : String(error) }
    }
    params.onChange()
  }

  function observe(message: unknown): void {
    if (!isRecord(message) || message['type'] !== 'system') return

    if (message['subtype'] === 'init') {
      initPlugins = initPluginsOf(message)
      if (params.request.source === 'installed' && initPlugins !== null) {
        const loaded = initPlugins.find((plugin) => plugin.name === PLUGIN_NAME)
        if (loaded !== undefined) {
          void ensureExpected(loaded.path).then(() => {
            recompute()
            params.onChange()
          })
        }
      }
      recompute()
      params.onChange()
      return
    }

    if (message['subtype'] === 'commands_changed') {
      const rawCommands = message['commands']
      if (!Array.isArray(rawCommands)) return
      commands = toCommandSummaries(rawCommands as SlashCommand[])
      recompute()
      params.onChange()
    }
  }

  return {
    start,
    observe,
    current: () => state,
    has: (name) => commands.some((command) => command.name === name),
  }
}
