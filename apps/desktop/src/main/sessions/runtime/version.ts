// No semver dependency — a three-number component-wise compare is all a `\d+\.\d+\.\d+` prefix needs. Below the minimum never blocks: the policy is "try it and see", so this only sets `belowMinimum`.
import type { Platform } from '@/main/platform'
import { MINIMUM_CLAUDE_CODE_VERSION } from '@/types/runtime'

const VERSION_RE = /(\d+)\.(\d+)\.(\d+)/

type VersionTuple = readonly [number, number, number]

function parseVersion(text: string): VersionTuple | null {
  const match = VERSION_RE.exec(text)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Component-wise, never a string compare — `'2.9.0' < '2.10.0'` disagrees once a component reaches two digits. */
function compareVersions(a: VersionTuple, b: VersionTuple): number {
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left - right
  }
  return 0
}

type ReadVersionResult = { readonly ok: true; readonly raw: string; readonly belowMinimum: boolean } | { readonly ok: false }

// 10s — a single short-lived process with no network I/O, well under the platform layer's 30s default.
const VERSION_TIMEOUT_MS = 10_000

export async function readClaudeVersion(ctx: Pick<Platform, 'run'>, minimum: string = MINIMUM_CLAUDE_CODE_VERSION): Promise<ReadVersionResult> {
  const result = await ctx.run('claude', ['--version'], { timeoutMs: VERSION_TIMEOUT_MS })
  if (!result.ok) return { ok: false }

  const parsed = parseVersion(result.stdout)
  if (parsed === null) return { ok: false }

  const parsedMinimum = parseVersion(minimum)
  const belowMinimum = parsedMinimum !== null && compareVersions(parsed, parsedMinimum) < 0
  return { ok: true, raw: `${String(parsed[0])}.${String(parsed[1])}.${String(parsed[2])}`, belowMinimum }
}
