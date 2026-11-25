// Pure verification logic over a hosted session's plugin load and command/agent inventory, read
// back rather than assumed. Split from capabilities.ts's I/O and timing shell.
import type { PluginLoad } from '@/types/hosting'

export const PLUGIN_NAME = 'port'

/** The shape `system`/`init`'s own `plugins` field carries, narrowed to what this module reads. */
export interface InitPlugin {
  readonly name: string
  readonly path: string
  readonly version?: string
}

interface CheckPluginLoadParams {
  /** `null` before any `init` has arrived. */
  readonly initPlugins: readonly InitPlugin[] | null
}

/** Zero plugins named `port` → `missing`; two or more → `duplicate`; exactly one → `loaded`. */
export function checkPluginLoad(params: CheckPluginLoadParams): PluginLoad {
  if (params.initPlugins === null) return { kind: 'unconfirmed' }

  const loaded = params.initPlugins.filter((plugin) => plugin.name === PLUGIN_NAME)
  const only = loaded[0]
  if (only === undefined) return { kind: 'missing' }
  if (loaded.length > 1) return { kind: 'duplicate', paths: loaded.map((plugin) => plugin.path) }
  return { kind: 'loaded', path: only.path, version: only.version ?? null }
}

type CommandNameResult = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/** No control-character regex literal (`no-control-regex`) — checked by code point instead. */
function hasControlCharacter(name: string): boolean {
  for (const char of name) {
    const codePoint = char.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}

/** Mirrors the SDK's own skill-name validator, rule for rule. */
export function validateCommandName(name: string): CommandNameResult {
  if (name === '') return { ok: false, reason: 'the command name is empty' }
  if (name.trim() !== name) return { ok: false, reason: 'the command name has leading or trailing whitespace' }
  if (name.startsWith('/')) return { ok: false, reason: 'the command name must not start with a leading /' }
  if (name === '*' || name.endsWith(':*') || name.endsWith(' *')) return { ok: false, reason: 'the command name must not be a wildcard' }
  if (name.includes('(') || name.includes(')') || name.includes(',')) return { ok: false, reason: "the command name must not contain '(', ')', or ','" }
  if (hasControlCharacter(name)) return { ok: false, reason: 'the command name must not contain control characters' }
  if (name.includes('\\')) return { ok: false, reason: "the command name must not contain '\\', and none may trail it" }
  return { ok: true }
}

/** `/${name}`, or `/${name} ${args.trim()}` when the trimmed args are
 *  non-empty. */
export function composeInvocation(name: string, args: string): string {
  const trimmed = args.trim()
  return trimmed === '' ? `/${name}` : `/${name} ${trimmed}`
}

interface BlockedCommandContext {
  readonly stage: boolean
  /** The reported `port:` command names, qualifier stripped. */
  readonly portNames: readonly string[]
  /** The bare names the session reports as its own. */
  readonly unqualifiedNames: readonly string[]
}

/** `port:pipeline` and an unreported bare `pipeline` are always blocked; a stage session also blocks every `port:` name and any unreported bare name that is a port command. Exact matches only. */
export function isBlockedCommand(name: string, context: BlockedCommandContext): boolean {
  if (name === `${PLUGIN_NAME}:pipeline`) return true
  if (name === 'pipeline' && !context.unqualifiedNames.includes('pipeline')) return true
  if (!context.stage) return false
  if (name.startsWith(`${PLUGIN_NAME}:`)) return true
  return context.portNames.includes(name) && !context.unqualifiedNames.includes(name)
}
