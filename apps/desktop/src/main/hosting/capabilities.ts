// #101: the per-session capability tracker — reads `supportedCommands()`/
// `supportedAgents()` back rather than trusting a plugin flag worked
// (ENGINEERING §7's "malformed component is silently absent" rule, applied
// here to the read-back itself: a timeout or a rejection must never present
// as an empty list, which would look identical to "the plugin loaded with
// nothing to offer"). Pure decision logic lives in `verify.ts`; this file
// is only the I/O and timing shell around it (ENGINEERING §1).
import type { AgentSummary, CommandSummary, PluginRequest, SessionCapabilities } from '../../shared/hosting/types'
import { sanitize } from '../sessions'
import { checkComponents, checkPluginLoad, PLUGIN_NAME } from './verify'
import type { InitPlugin } from './verify'
import type { ExpectedComponents } from './plugin'
import type { AgentInfo, HostedQuery, SlashCommand } from './sdk'

/** These are control requests, answered before the first turn and costing
 *  no tokens — a stalled or unresponsive CLI must never park the strip
 *  forever, so the wait is bounded the same way `handle.ts`'s own
 *  close-grace wait is (`AbortSignal.timeout`, never a manually scheduled
 *  callback). */
export const CAPABILITIES_TIMEOUT_MS = 30_000

const QUALIFIER = `${PLUGIN_NAME}:`

export interface CreateCapabilityTrackerParams {
  readonly request: PluginRequest
  readonly readExpectedComponents: (pluginPath: string) => Promise<ExpectedComponents | null>
  readonly samePath: (a: string, b: string) => boolean
  readonly onChange: () => void
  /** Test-only override of `CAPABILITIES_TIMEOUT_MS` — every real caller
   *  leaves this at its default. */
  readonly timeoutMs?: number
}

export interface CapabilityTracker {
  /** Fired once, right after `query()` — races `supportedCommands()`/
   *  `supportedAgents()` against `CAPABILITIES_TIMEOUT_MS`. Neither a
   *  timeout nor a rejected call is ever read as an empty list; both go to
   *  `unavailable`, the message carried verbatim. */
  start(query: HostedQuery): Promise<void>
  /** Folds one raw SDK message into this tracker's state — a no-op for
   *  anything but `system`/`init` and `system`/`commands_changed`. */
  observe(message: unknown): void
  current(): SessionCapabilities
  /** Whether `name` (already namespace-stripped, e.g. `'pipeline'`) is in
   *  this session's current `port:` command list — `handle.ts`'s `invoke`
   *  own membership check, so a renderer can never run a command the
   *  session did not itself report. */
  has(name: string): boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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

/** A runtime-native deadline, never a manually scheduled callback of this
 *  app's own — the same idiom `handle.ts`'s own `grace()` uses, here made
 *  to reject rather than resolve so `Promise.race` treats an unanswered
 *  control request as a failure, not a silent empty result. */
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
  /** Distinct from `expectedRequested`: this flips only once the read has
   *  actually settled, so `checkComponents` can tell "no path yet" from "a
   *  read is in flight or failed" — both leave `expected` at `null`. */
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
