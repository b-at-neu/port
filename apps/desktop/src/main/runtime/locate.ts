// Resolves the `claude` executable the SDK should point at, and refuses the Agent SDK's own bundled per-platform binary (~327MB) — a silent fallback to that path is a bug to surface.
import { createPathOps } from '../platform/paths'
import { which as defaultWhich } from '../platform/which'
import type { PathOps } from '../platform/paths'
import type { WhichEnv, WhichOptions, WhichResult } from '../platform/which'

export type LocateResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly kind: 'not-found'; readonly searched: readonly string[] }
  | { readonly ok: false; readonly kind: 'bundled-fallback'; readonly path: string }

export interface ResolveClaudeExecutableOptions {
  readonly env: WhichEnv
  readonly platform: NodeJS.Platform
  readonly which?: (options: WhichOptions) => Promise<WhichResult>
}

/** Platform/arch tokens are whitelisted rather than a generic shape, so an unrelated sibling package sharing the string prefix is never mistaken for one. */
const SDK_PACKAGE_DIR_RE = /^claude-agent-sdk(-(?:linux|darwin|win32)-(?:x64|arm64)(-musl)?)?$/

function pathOpsFor(platform: NodeJS.Platform): PathOps {
  return createPathOps(platform === 'win32' ? 'win32' : 'posix', { home: '' })
}

/** Segment-matched first, then confirmed with `ops.contains` rather than a naive `startsWith`, which a sibling sharing the same string prefix would pass wrongly. */
export function bundledSdkPackageDir(resolvedPath: string, ops: PathOps): string | null {
  let current = resolvedPath
  for (;;) {
    const parent = ops.dirname(current)
    if (parent === current) return null
    const name = ops.basename(parent)
    if (SDK_PACKAGE_DIR_RE.test(name)) {
      const scope = ops.basename(ops.dirname(parent))
      if (scope === '@anthropic-ai' && ops.contains(parent, resolvedPath)) return parent
    }
    current = parent
  }
}

/** Refuses a bundled-SDK path before ever calling it usable — the ladder `classify.ts` consumes starts here. */
export async function resolveClaudeExecutable(options: ResolveClaudeExecutableOptions): Promise<LocateResult> {
  const whichFn = options.which ?? defaultWhich
  const result = await whichFn({ command: 'claude', env: options.env, platform: options.platform })
  if (!result.ok) return { ok: false, kind: 'not-found', searched: result.searched }

  const ops = pathOpsFor(options.platform)
  if (bundledSdkPackageDir(result.path, ops) !== null) {
    return { ok: false, kind: 'bundled-fallback', path: result.path }
  }
  return { ok: true, path: result.path }
}
