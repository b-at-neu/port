// #97: resolves the `claude` executable the SDK should be pointed at, and
// refuses the Agent SDK's own bundled per-platform binary
// (`@anthropic-ai/claude-agent-sdk-{platform}-{arch}/claude`, ~327MB) — a
// silent fallback to that path is a bug to surface, never a degradation to
// accept, since passing the override is what lets a shipped build avoid it.
import { createPathOps, which as defaultWhich } from '../platform'
import type { PathOps, WhichEnv, WhichOptions, WhichResult } from '../platform'

export type LocateResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly kind: 'not-found'; readonly searched: readonly string[] }
  | { readonly ok: false; readonly kind: 'bundled-fallback'; readonly path: string }

export interface ResolveClaudeExecutableOptions {
  readonly env: WhichEnv
  readonly platform: NodeJS.Platform
  readonly which?: (options: WhichOptions) => Promise<WhichResult>
}

/** Every package name the Agent SDK's own `optionalDependencies` carry
 *  (`sdk/package.json`): the main package plus one per real platform/arch
 *  pair, all siblings under the same `@anthropic-ai/` scope directory. A
 *  resolved `claude` sitting inside any of them is the SDK's own bundled
 *  binary, never the operator's own install. The platform/arch tokens are
 *  whitelisted rather than a generic `[a-z0-9]+-[a-z0-9]+` shape, so an
 *  unrelated sibling package that merely shares the string prefix (e.g.
 *  `claude-agent-sdk-extra-tool`) is never mistaken for one. */
const SDK_PACKAGE_DIR_RE = /^claude-agent-sdk(-(?:linux|darwin|win32)-(?:x64|arm64)(-musl)?)?$/

function pathOpsFor(platform: NodeJS.Platform): PathOps {
  return createPathOps(platform === 'win32' ? 'win32' : 'posix', { home: '' })
}

/** Walks every ancestor of `resolvedPath` looking for a
 *  `@anthropic-ai/claude-agent-sdk*` package directory. Segment-matched
 *  first (cheap, and what actually finds the candidate), then the match
 *  itself is confirmed with `ops.contains` rather than trusted as a
 *  substring `startsWith` would be — a sibling directory sharing the same
 *  string prefix (`claude-agent-sdk-extra`) would pass a naive prefix check
 *  wrongly; walking ancestors and comparing whole path segments never can. */
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

/** Resolves the executable through `which`, then refuses a bundled-SDK path
 *  before ever calling it usable — the ladder `main/runtime/classify.ts`
 *  consumes starts here. */
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
