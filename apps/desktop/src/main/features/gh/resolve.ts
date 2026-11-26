// `'gh:status'`'s composition — the footer's status dot. This file never
// throws for a gh failure itself; every outcome is a value.
import type { GhStatus } from '@/types/gh'
import type { AppContext } from '@/main/app/context'
import type { CommandResult } from '@/types/platform'

// Every failure `ctx.run` can return once 'not-found' and 'nonzero' are handled separately below.
function messageFor(result: Exclude<CommandResult, { ok: true } | { ok: false; kind: 'not-found' | 'nonzero' }>): string {
  switch (result.kind) {
    case 'cwd-missing':
      return `working directory not found: ${result.cwd}`
    case 'signalled':
      return `gh was terminated by signal ${result.signal}`
    case 'timeout':
      return `gh timed out after ${String(result.timeoutMs)}ms`
    case 'output-too-large':
      return 'gh produced more output than this app will buffer'
    case 'spawn-failed':
      return result.message
  }
}

const ACCOUNT_LINE = /Logged in to \S+ account (\S+)/
const SCOPES_LINE = /Token scopes:\s*(.*)/

interface ParsedGhAuth {
  readonly account: string | null
  readonly scopes: readonly string[] | null
}

/** Reads the active account's login and token scopes; anything unparsable is `null`, never a guess. */
export function parseGhAuthStatus(output: string): ParsedGhAuth {
  const blocks: { readonly account: string; readonly lines: string[] }[] = []
  for (const line of output.split(/\r?\n/)) {
    const account = ACCOUNT_LINE.exec(line)?.[1]
    if (account !== undefined) blocks.push({ account, lines: [] })
    else blocks.at(-1)?.lines.push(line)
  }
  const block = blocks.find((b) => b.lines.some((line) => /Active account:\s*true/.test(line))) ?? blocks[0]
  if (block === undefined) return { account: null, scopes: null }
  const raw = block.lines.map((line) => SCOPES_LINE.exec(line)?.[1]).find((value) => value !== undefined)
  if (raw === undefined) return { account: block.account, scopes: null }
  const scopes = raw.trim() === 'none' ? [] : raw.split(',').map((scope) => scope.trim().replace(/^['"]|['"]$/g, '')).filter((scope) => scope !== '')
  return { account: block.account, scopes }
}

export async function readGhStatus(ctx: Pick<AppContext, 'run' | 'clock'>): Promise<GhStatus> {
  const checkedAt = ctx.clock.now().toISOString()
  const result = await ctx.run('gh', ['auth', 'status'], { timeoutMs: 8_000 })
  if (result.ok) return { kind: 'signed-in', checkedAt, ...parseGhAuthStatus(`${result.stdout}\n${result.stderr}`) }
  if (result.kind === 'nonzero') return { kind: 'signed-out', checkedAt }
  if (result.kind === 'not-found') return { kind: 'missing', checkedAt }
  return { kind: 'unknown', message: messageFor(result), checkedAt }
}
