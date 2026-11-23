// Every string the Pipeline strip renders — pure copy, keyed exhaustively over
// `PluginLoad` and invoke-failure so a new variant fails typecheck until its own copy exists.
import type { SessionCapabilities, SessionInvokeResult } from '@/types/hosting'
import { SEND_FAILED_UNKNOWN_SESSION } from '@/renderer/session/copy'

/** `a and b`, `a, b, and c`, … — an Oxford-comma list rather than
 *  `paths.join(' and ')`, which reads as `a and b and c` for three or more
 *  duplicate-loaded paths (a rare edge case, but an awkward one to read). */
function joinWithAnd(items: readonly string[]): string {
  if (items.length <= 2) return items.join(' and ')
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

/** The status chip's text — glyph plus words, never colour alone. The full
 *  path is never in the chip itself (it goes in the element's `title`,
 *  `commands.ts`'s own job). */
export function chipCopy(capabilities: SessionCapabilities): string {
  if (capabilities.kind === 'pending') return '◌ Pipeline · loading commands…'
  if (capabilities.kind === 'unavailable') return '⚠ Pipeline commands unavailable'

  const { plugin } = capabilities

  switch (plugin.kind) {
    case 'unconfirmed':
      return '◌ port · confirmed on the first turn'
    case 'missing':
      return "⚠ port didn't load"
    case 'duplicate':
      return '⚠ Two port plugins loaded'
    case 'loaded':
      return plugin.version === null ? '✓ port' : `✓ port ${plugin.version}`
  }
}

interface CapabilitiesBanner {
  readonly text: string
  /** SDK message text, shown verbatim in a `<pre>` — `unavailable` only. */
  readonly detail: string | null
}

/** The banner under the chip (`aria-live="polite"`) — `null` when there is nothing to say. */
export function bannerCopy(capabilities: SessionCapabilities): CapabilitiesBanner | null {
  if (capabilities.kind === 'pending') return null
  if (capabilities.kind === 'unavailable') return { text: "Claude Code didn't return this session's commands.", detail: capabilities.message }

  const { plugin } = capabilities

  if (plugin.kind === 'missing') {
    return { text: "This session has no port plugin. The repository's `.claude/settings.json` enables `port@port` — check the install with `/plugin` in a terminal session.", detail: null }
  }

  if (plugin.kind === 'duplicate') {
    return { text: `Claude Code loaded port from ${joinWithAnd(plugin.paths)}. A command may resolve to either copy.`, detail: null }
  }

  return null
}

export const INVOKE_REJECTED = "Couldn't reach the main process. The command wasn't sent."

/** `name` is the command the operator clicked, namespace-stripped — carried
 *  separately from `result` since `invalid-command` names no command of its
 *  own (only `reason`). */
export function invokeFailureCopy(name: string, result: Extract<SessionInvokeResult, { readonly ok: false }>): string {
  switch (result.kind) {
    case 'invalid-command':
      return `Port didn't send /${name}: ${result.reason}.`
    case 'unknown-command':
      return `/${result.name} isn't available in this session any more.`
    case 'unknown-session':
      return SEND_FAILED_UNKNOWN_SESSION
  }
}

/** A hint starting with `<` names a required argument (e.g.
 *  `<feature description>`) — an empty hint, or one that is merely
 *  descriptive prose, never requires the argument row to hold text before
 *  `Run` enables. */
export function argumentRequired(hint: string): boolean {
  return hint.startsWith('<')
}
