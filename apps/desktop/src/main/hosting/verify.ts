// #101: pure verification logic over what a hosted session's plugin load
// and slash-command/agent inventory actually turned out to be, read back
// rather than assumed — "a malformed component is *absent* from the
// inventory rather than reported as an error" (ENGINEERING §7) is the
// failure mode every function here exists to surface instead of hide.
// Split from `capabilities.ts`'s I/O and timing shell the same way every
// other topic module in this app separates pure decision logic from
// wiring (ENGINEERING §1).
import type { ComponentCheck, PluginLoad, PluginRequest } from '../../shared/hosting/types'

export const PLUGIN_NAME = 'port'

/** The shape `system`/`init`'s own `plugins` field carries, narrowed down
 *  to what this module reads — never the SDK's own message type (this
 *  app's shared types never name one, see `shared/hosting/types.ts`'s own
 *  rule). */
export interface InitPlugin {
  readonly name: string
  readonly path: string
  readonly version?: string
}

export interface CheckPluginLoadParams {
  readonly request: PluginRequest
  /** `null` before any `init` has arrived. */
  readonly initPlugins: readonly InitPlugin[] | null
  readonly samePath: (a: string, b: string) => boolean
}

/** Zero plugins named `port` → `missing`; two or more → `duplicate`. Exactly
 *  one, requested from the repository, whose reported path disagrees with
 *  the one asked for → `shadowed` — including when `samePath` itself throws
 *  on a non-absolute reported path, since that is never guessed as a match
 *  either. The `installed` source carries no path to compare against, so
 *  its one loaded entry is always `loaded`. */
export function checkPluginLoad(params: CheckPluginLoadParams): PluginLoad {
  if (params.initPlugins === null) return { kind: 'unconfirmed' }

  const loaded = params.initPlugins.filter((plugin) => plugin.name === PLUGIN_NAME)
  if (loaded.length === 0) return { kind: 'missing' }
  if (loaded.length > 1) return { kind: 'duplicate', paths: loaded.map((plugin) => plugin.path) }

  const only = loaded[0]
  if (only === undefined) return { kind: 'missing' }

  if (params.request.source === 'repository') {
    let same: boolean
    try {
      same = params.samePath(params.request.path, only.path)
    } catch {
      same = false
    }
    if (!same) return { kind: 'shadowed', path: only.path, version: only.version ?? null }
  }

  return { kind: 'loaded', path: only.path, version: only.version ?? null }
}

export interface CheckComponentsParams {
  /** `null` when there is nothing to compare against yet — never treated as
   *  `complete` (ENGINEERING §4's "fails closed on complete" direction). */
  readonly expected: { readonly skills: readonly string[]; readonly agents: readonly string[] } | null
  /** Whether a read of the plugin directory has actually settled (succeeded
   *  or failed). `false` means there was no plugin path yet to read from —
   *  the `installed` source before `init` has reported one — so `expected`
   *  being `null` reflects `'no-plugin-path'`, not a failed read. */
  readonly expectedAttempted: boolean
  /** Already stripped of the `port:` qualifier. */
  readonly commandNames: readonly string[]
  readonly agentNames: readonly string[]
}

export function checkComponents(params: CheckComponentsParams): ComponentCheck {
  if (params.expected === null) return { kind: 'unchecked', reason: params.expectedAttempted ? 'unreadable' : 'no-plugin-path' }

  const missingSkills = params.expected.skills.filter((skill) => !params.commandNames.includes(skill))
  const missingAgents = params.expected.agents.filter((agent) => !params.agentNames.includes(agent))
  if (missingSkills.length === 0 && missingAgents.length === 0) return { kind: 'complete' }
  return { kind: 'incomplete', missingSkills, missingAgents }
}

export type CommandNameResult = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/** No control-character regex literal (`no-control-regex`) — checked by
 *  code point instead, the same idiom `main/sessions/transcript-entries.ts`'s
 *  own `sanitize` already uses for the same class of character. */
function hasControlCharacter(name: string): boolean {
  for (const char of name) {
    const codePoint = char.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}

/** Mirrors the SDK's own skill-name validator, rule for rule (SDK 0.3.261) —
 *  this file's header states that copy relationship rather than a contract
 *  the SDK owes this app; `capabilities.ts`'s own membership check
 *  (`CapabilityTracker.has`) is what actually bounds the invoke path. */
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
