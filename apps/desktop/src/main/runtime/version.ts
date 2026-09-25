// #97: reads the installed CLI's version and compares it against
// `MINIMUM_CLAUDE_CODE_VERSION` (no semver dependency — a three-number
// component-wise compare is all a `\d+\.\d+\.\d+` prefix needs). Below the
// minimum never blocks — the policy is "try it and see" — it only sets
// `belowMinimum`, which turns an otherwise opaque probe failure into
// "update Claude Code" instead. A resolved path that does not spawn, or
// whose output nothing parses out of, is `ok: false` here — the caller
// (`classify.ts`) turns that into `cli-unusable`, never a silent `ready`.
import { claude } from '../platform'
import type { ClaudeOptions, CommandResult } from '../platform'
import { MINIMUM_CLAUDE_CODE_VERSION } from '../../shared/runtime/types'

const VERSION_RE = /(\d+)\.(\d+)\.(\d+)/

type VersionTuple = readonly [number, number, number]

function parseVersion(text: string): VersionTuple | null {
  const match = VERSION_RE.exec(text)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Component-wise, never a string compare — `'2.9.0' < '2.10.0'` disagrees
 *  with the string ordering the moment either component reaches two
 *  digits. */
function compareVersions(a: VersionTuple, b: VersionTuple): number {
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left - right
  }
  return 0
}

export type ReadVersionResult = { readonly ok: true; readonly raw: string; readonly belowMinimum: boolean } | { readonly ok: false }

export interface ReadClaudeVersionOptions {
  readonly runClaude?: (args: readonly string[], options?: ClaudeOptions) => Promise<CommandResult>
  readonly minimum?: string
}

export async function readClaudeVersion(options: ReadClaudeVersionOptions = {}): Promise<ReadVersionResult> {
  const runClaude = options.runClaude ?? claude
  const minimum = options.minimum ?? MINIMUM_CLAUDE_CODE_VERSION

  const result = await runClaude(['--version'])
  if (!result.ok) return { ok: false }

  const parsed = parseVersion(result.stdout)
  if (parsed === null) return { ok: false }

  const parsedMinimum = parseVersion(minimum)
  const belowMinimum = parsedMinimum !== null && compareVersions(parsed, parsedMinimum) < 0
  return { ok: true, raw: `${String(parsed[0])}.${String(parsed[1])}.${String(parsed[2])}`, belowMinimum }
}
