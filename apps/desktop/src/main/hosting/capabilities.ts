import type { ExpectedComponents, InitPlugin, PluginRequest } from '@/types/hosting-plugin'
import type { HostedQuery } from '@/main/hosting/sdk'

// A timeout or rejected read-back must never look like an empty capability list.
import type { AgentSummary, CommandSummary, SessionCapabilities, SlashCommandSummary } from '@/types/hosting'
import { isRecord } from '@/main/guards'
import { sanitize } from '@/main/sessions/transcript-entries'
import { checkComponents, checkPluginLoad, isBlockedCommand, PLUGIN_NAME } from '@/main/hosting/verify'


import type { AgentInfo, SlashCommand } from '@/main/hosting/sdk'

/** Control requests answered before the first turn, costing no tokens. */
export const CAPABILITIES_TIMEOUT_MS = 30_000

const QUALIFIER = `${PLUGIN_NAME}:`

interface CreateCapabilityTrackerParams {
  readonly request: PluginRequest
  readonly readExpectedComponents: (pluginPath: string) => Promise<ExpectedComponents | null>
  readonly samePath: (a: string, b: string) => boolean
  readonly onChange: () => void
  /** A stage session hides and refuses every `port:` command, not just pipeline. */
  readonly stage: boolean
  /** Test-only override of `CAPABILITIES_TIMEOUT_MS`. */
  readonly timeoutMs?: number
}

interface CapabilityTracker {
  start(query: HostedQuery): Promise<void>
  observe(message: unknown): void
  current(): SessionCapabilities
  has(name: string): boolean
  /** Whether this session refuses `name`, read against its latest reported command list. */
  isBlocked(name: string): boolean
}

function isPortQualified(name: string): boolean {
  return name.startsWith(QUALIFIER) && name.length > QUALIFIER.length
}

function blockContext(raw: readonly SlashCommand[], stage: boolean): Parameters<typeof isBlockedCommand>[1] {
  return {
    stage,
    portNames: raw.filter((command) => isPortQualified(command.name)).map((command) => command.name.slice(QUALIFIER.length)),
    unqualifiedNames: raw.filter((command) => !isPortQualified(command.name)).map((command) => command.name),
  }
}

/** Every `port:` command except pipeline, whatever the session kind — the component check reads this list. */
function toCommandSummaries(raw: readonly SlashCommand[]): CommandSummary[] {
  const context = blockContext(raw, false)
  return raw
    .filter((command) => isPortQualified(command.name) && !isBlockedCommand(command.name, context))
    .map((command) => ({ name: command.name.slice(QUALIFIER.length), description: sanitize(command.description), argumentHint: command.argumentHint }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The composer's `/` autocomplete source — every reported command, namespace
 *  intact, unlike `toCommandSummaries`'s own `port:`-qualified filter. */
function toSlashCommandSummaries(raw: readonly SlashCommand[], stage: boolean): SlashCommandSummary[] {
  const context = blockContext(raw, stage)
  return raw
    .filter((command) => !isBlockedCommand(command.name, context))
    .map((command) => ({ name: command.name, description: sanitize(command.description), argumentHint: command.argumentHint }))
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
  let rawCommands: readonly SlashCommand[] = []
  let portCommands: CommandSummary[] = []
  let agents: AgentSummary[] = []
  let slashCommands: SlashCommandSummary[] = []
  let initPlugins: readonly InitPlugin[] | null = null

  /** The command strip and the invoke path; empty in a stage session, so neither can run a port command. */
  function exposedCommands(): CommandSummary[] {
    return params.stage ? [] : portCommands
  }

  function adoptCommands(raw: readonly SlashCommand[]): void {
    rawCommands = raw
    portCommands = toCommandSummaries(raw)
    slashCommands = toSlashCommandSummaries(raw, params.stage)
  }

  function recompute(): void {
    const plugin = checkPluginLoad({ request: params.request, initPlugins, samePath: params.samePath })
    const components = checkComponents({
      expected,
      expectedAttempted: expectedSettled,
      commandNames: portCommands.map((command) => command.name),
      agentNames: agents.map((agent) => agent.name),
    })
    state = { kind: 'ready', request: params.request, commands: exposedCommands(), agents, plugin, components, slashCommands }
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
      const [reportedCommands, reportedAgents] = await Promise.race([Promise.all([query.supportedCommands(), query.supportedAgents()]), timeoutRejection(params.timeoutMs ?? CAPABILITIES_TIMEOUT_MS)])
      adoptCommands(reportedCommands)
      agents = toAgentSummaries(reportedAgents)
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
      const changedCommands = message['commands']
      if (!Array.isArray(changedCommands)) return
      adoptCommands(changedCommands as SlashCommand[])
      recompute()
      params.onChange()
    }
  }

  return {
    start,
    observe,
    current: () => state,
    has: (name) => exposedCommands().some((command) => command.name === name),
    isBlocked: (name) => isBlockedCommand(name, blockContext(rawCommands, params.stage)),
  }
}
