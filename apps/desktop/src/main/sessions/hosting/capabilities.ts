import type { AgentInfo, HostedQuery, SlashCommand } from '@/main/platform/sdk'

// A timeout or rejected read-back must never look like an empty capability list.
import type { AgentSummary, CommandSummary, SessionCapabilities, SlashCommandSummary } from '@/types/hosting'
import { isRecord } from '@/utils/guards'
import { sanitize } from '@/main/sessions/transcript-entries'
import { checkPluginLoad, isBlockedCommand, PLUGIN_NAME, type InitPlugin } from '@/main/sessions/hosting/verify'

/** Control requests answered before the first turn, costing no tokens. */
export const CAPABILITIES_TIMEOUT_MS = 30_000

const QUALIFIER = `${PLUGIN_NAME}:`

interface CreateCapabilityTrackerParams {
  readonly onChange: () => void
  /** A stage session hides and refuses every `port:` command. */
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

/** Every `port:` command except pipeline, whatever the session kind. */
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
  let state: SessionCapabilities = { kind: 'pending' }
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
    state = { kind: 'ready', commands: exposedCommands(), agents, plugin: checkPluginLoad({ initPlugins }), slashCommands }
  }

  async function start(query: HostedQuery): Promise<void> {
    try {
      const [reportedCommands, reportedAgents] = await Promise.race([Promise.all([query.supportedCommands(), query.supportedAgents()]), timeoutRejection(params.timeoutMs ?? CAPABILITIES_TIMEOUT_MS)])
      adoptCommands(reportedCommands)
      agents = toAgentSummaries(reportedAgents)
      recompute()
    } catch (error) {
      state = { kind: 'unavailable', message: error instanceof Error ? error.message : String(error) }
    }
    params.onChange()
  }

  function observe(message: unknown): void {
    if (!isRecord(message) || message['type'] !== 'system') return

    if (message['subtype'] === 'init') {
      initPlugins = initPluginsOf(message)
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
