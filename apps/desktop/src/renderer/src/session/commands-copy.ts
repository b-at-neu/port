// #101: every string the Pipeline strip renders — pure copy, keyed
// exhaustively over `PluginLoad`/`ComponentCheck`/invoke-failure so a
// variant added to either union fails typecheck until its own copy exists
// here, the same `Record`-exhaustiveness rule `session/copy.ts` already
// establishes for `SessionPhase`/`SessionEndReason`.
import type { ComponentCheck, PluginRequest, SessionCapabilities, SessionInvokeResult } from '../../../shared/hosting/types'
import { SEND_FAILED_UNKNOWN_SESSION } from './copy'

const SOURCE_LABEL: Readonly<Record<PluginRequest['source'], string>> = {
  repository: 'repository copy',
  installed: 'installed copy',
}

function sourceLabelFor(request: PluginRequest): string {
  return SOURCE_LABEL[request.source]
}

function requestedPathFor(request: PluginRequest): string {
  return request.source === 'repository' ? request.path : 'the installed copy'
}

/** The status chip's text — glyph plus words, never colour alone. The full
 *  path is never in the chip itself (it goes in the element's `title`,
 *  `commands.ts`'s own job). */
export function chipCopy(capabilities: SessionCapabilities): string {
  if (capabilities.kind === 'pending') return '◌ Pipeline · loading commands…'
  if (capabilities.kind === 'unavailable') return '⚠ Pipeline commands unavailable'

  const { plugin, components, request } = capabilities
  const sourceLabel = sourceLabelFor(request)

  switch (plugin.kind) {
    case 'unconfirmed':
      return `◌ port · ${sourceLabel} · confirmed on the first turn`
    case 'missing':
      return "⚠ port didn't load"
    case 'shadowed':
      return '⚠ port loaded from another copy'
    case 'duplicate':
      return '⚠ Two port plugins loaded'
    case 'loaded': {
      const versionSuffix = plugin.version === null ? '' : ` ${plugin.version}`
      return `${componentGlyph(components)} port${versionSuffix}${componentSuffix(components, sourceLabel)}`
    }
  }
}

function componentGlyph(components: ComponentCheck): string {
  switch (components.kind) {
    case 'complete':
      return '✓'
    case 'unchecked':
      return '◐'
    case 'incomplete':
      return '⚠'
  }
}

function componentSuffix(components: ComponentCheck, sourceLabel: string): string {
  switch (components.kind) {
    case 'complete':
      return ` · ${sourceLabel}`
    case 'unchecked':
      return ' · components not checked'
    case 'incomplete':
      return ` · ${components.missingSkills.length + components.missingAgents.length} missing`
  }
}

export interface CapabilitiesBanner {
  readonly text: string
  /** SDK message text, shown verbatim in a `<pre>` — `unavailable` only. */
  readonly detail: string | null
}

/** The banner under the chip (`aria-live="polite"`) — `null` when there is
 *  nothing to say (`pending`, `unconfirmed`, or `loaded` + `complete`). */
export function bannerCopy(capabilities: SessionCapabilities): CapabilitiesBanner | null {
  if (capabilities.kind === 'pending') return null
  if (capabilities.kind === 'unavailable') return { text: "Claude Code didn't return this session's commands.", detail: capabilities.message }

  const { plugin, components, request } = capabilities

  if (plugin.kind === 'missing') {
    return request.source === 'repository'
      ? {
          text: `Port passed ${request.path} to Claude Code, but this session has no port plugin. An invalid \`.claude-plugin/plugin.json\`, or a managed policy that blocks \`--plugin-dir\`, stops it loading.`,
          detail: null,
        }
      : { text: "This session has no port plugin. The repository's `.claude/settings.json` enables `port@port` — check the install with `/plugin` in a terminal session.", detail: null }
  }

  if (plugin.kind === 'shadowed') {
    return { text: `Port asked for ${requestedPathFor(request)}, but Claude Code loaded ${plugin.path}. Commands run from the loaded copy.`, detail: null }
  }

  if (plugin.kind === 'duplicate') {
    return { text: `Claude Code loaded port from ${plugin.paths.join(' and ')}. A command may resolve to either copy.`, detail: null }
  }

  if (plugin.kind === 'loaded') {
    if (components.kind === 'unchecked') {
      const path = request.source === 'repository' ? request.path : plugin.path
      return { text: `Port couldn't read ${path} to check which skills and agents should be there.`, detail: null }
    }
    if (components.kind === 'incomplete') {
      const parts = [...components.missingSkills.map((skill) => `skill \`${skill}\``), ...components.missingAgents.map((agent) => `agent \`${agent}\``)]
      return { text: `These didn't load: ${parts.join(', ')}. Claude Code silently drops a skill or agent with malformed frontmatter — check that file's \`name\` and \`description\`.`, detail: null }
    }
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
