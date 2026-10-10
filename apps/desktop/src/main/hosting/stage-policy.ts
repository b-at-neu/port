// Pure routing for a stage session's `canUseTool`: `AskUserQuestion`/`ExitPlanMode` always pause, an edit under `sessionRequiredPaths` pauses as protected, and everything else the repository's own allowlist did not already auto-approve is denied at once.
import type { PathOps } from '../platform/paths'

/** Mirrors `plugins/port/hooks/lib/guard-rules.mjs`'s own `globToRegExp` byte-for-byte — a test asserts both sides agree over a shared case list. `**` → any depth, `*` → one path segment, else escaped. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*'
      i++
    } else if (c === '*') {
      re += '[^/]*'
    } else {
      re += (c ?? '').replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

export const STAGE_DENY_MESSAGE = "This tool call isn't on this repository's allowlist, so port denied it. Carry on without it, or end with BLOCKED: naming the exact call."

export type StagePolicyDecision = { readonly kind: 'ask'; readonly protectedPath: string | null } | { readonly kind: 'deny'; readonly message: string }

export interface StagePolicyParams {
  readonly cwd: string
  readonly sessionRequiredPaths: readonly string[]
  readonly pathOps: Pick<PathOps, 'contains' | 'resolveFrom' | 'toPosix'>
}

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const INTERACTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

/** Reads `file_path` (or `notebook_path`, for `NotebookEdit`) off an edit-shaped `input` — `null` for anything else or a non-string value. */
function editPathOf(toolName: string, input: Readonly<Record<string, unknown>>): string | null {
  const raw = toolName === 'NotebookEdit' ? input.notebook_path : input.file_path
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

/** `stagePolicy({ cwd, sessionRequiredPaths, pathOps })` returns the one function a stage session's `canUseTool` consults first. The fail direction is deny — an unrecognized edit shape is never paused, since a pause stalls a slot until an operator notices, and a path outside `cwd` is never protected-ask, since the worktree is the stage's whole world. */
export function stagePolicy(params: StagePolicyParams): (toolName: string, input: Readonly<Record<string, unknown>>) => StagePolicyDecision {
  return (toolName, input) => {
    if (INTERACTION_TOOLS.has(toolName)) return { kind: 'ask', protectedPath: null }

    if (EDIT_TOOLS.has(toolName)) {
      const rawPath = editPathOf(toolName, input)
      if (rawPath === null) return { kind: 'deny', message: STAGE_DENY_MESSAGE }
      const resolved = params.pathOps.resolveFrom(params.cwd, rawPath)
      if (!params.pathOps.contains(params.cwd, resolved)) return { kind: 'deny', message: STAGE_DENY_MESSAGE }
      const relPath = params.pathOps.toPosix(resolved).slice(params.pathOps.toPosix(params.cwd).length + 1)
      const matched = params.sessionRequiredPaths.some((glob) => globToRegExp(glob).test(relPath))
      if (matched) return { kind: 'ask', protectedPath: relPath }
      return { kind: 'deny', message: STAGE_DENY_MESSAGE }
    }

    return { kind: 'deny', message: STAGE_DENY_MESSAGE }
  }
}
