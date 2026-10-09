// Pure composer logic: trigger detection, suggestion acceptance, and ranking — no DOM, no React.
import type { SlashCommandSummary } from '../../../shared/hosting/types'

export type TriggerKind = 'command' | 'file'

export interface ActiveTrigger {
  readonly kind: TriggerKind
  /** The trigger character's own index in `value` (`/` or `@`). */
  readonly start: number
  /** The text typed after the trigger character, up to the caret. */
  readonly query: string
}

function isWhitespace(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char)
}

/** `/` opens only at the start of the draft; `@` opens at the start or after whitespace. Neither survives a space typed in the token. */
export function activeTrigger(value: string, caret: number): ActiveTrigger | null {
  const before = value.slice(0, caret)

  if (before.startsWith('/')) {
    const token = before.slice(1)
    if (!/\s/.test(token)) return { kind: 'command', start: 0, query: token }
  }

  for (let i = caret - 1; i >= 0; i -= 1) {
    const char = before[i]
    if (char === '@' && isWhitespace(before[i - 1])) {
      return { kind: 'file', start: i, query: before.slice(i + 1) }
    }
    if (char !== undefined && /\s/.test(char)) break
  }

  return null
}

export interface AppliedSuggestion {
  readonly value: string
  readonly caret: number
}

/** Replaces the trigger's own token with `<trigger><name> `, caret right after it. */
export function applySuggestion(value: string, trigger: ActiveTrigger, name: string): AppliedSuggestion {
  const triggerChar = trigger.kind === 'command' ? '/' : '@'
  const tokenEnd = trigger.start + 1 + trigger.query.length
  const inserted = `${triggerChar}${name} `
  const nextValue = value.slice(0, trigger.start) + inserted + value.slice(tokenEnd)
  return { value: nextValue, caret: trigger.start + inserted.length }
}

/** Name prefix match, then name substring, then description substring —
 *  alphabetical within each tier. Case-insensitive throughout. */
export function rankCommands(commands: readonly SlashCommandSummary[], query: string): SlashCommandSummary[] {
  const needle = query.toLowerCase()
  function tier(command: SlashCommandSummary): number {
    const name = command.name.toLowerCase()
    if (name.startsWith(needle)) return 0
    if (name.includes(needle)) return 1
    if (command.description.toLowerCase().includes(needle)) return 2
    return 3
  }
  return commands
    .map((command) => ({ command, tier: tier(command) }))
    .filter((entry) => entry.tier < 3)
    .sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : a.command.name.localeCompare(b.command.name)))
    .map((entry) => entry.command)
}

const MAX_FILE_MATCHES = 50

/** A loose in-order subsequence match, scored by contiguity and basename/boundary hits, capped at the top 50. */
export function fuzzyRankFiles(files: readonly string[], query: string): string[] {
  if (query === '') return files.slice(0, MAX_FILE_MATCHES)
  const needle = query.toLowerCase()

  function score(path: string): number | null {
    const lower = path.toLowerCase()
    let needleIndex = 0
    let longestRun = 0
    let currentRun = 0
    let firstMatchIndex = -1
    let lastMatchIndex = -1

    for (let i = 0; i < lower.length && needleIndex < needle.length; i += 1) {
      if (lower[i] === needle[needleIndex]) {
        if (firstMatchIndex === -1) firstMatchIndex = i
        lastMatchIndex = i
        currentRun += 1
        longestRun = Math.max(longestRun, currentRun)
        needleIndex += 1
      } else {
        currentRun = 0
      }
    }
    if (needleIndex < needle.length) return null

    const basenameStart = lower.lastIndexOf('/') + 1
    const basename = lower.slice(basenameStart)
    let points = longestRun * 10
    if (basename.includes(needle)) points += 50
    if (firstMatchIndex === 0 || lower[firstMatchIndex - 1] === '/') points += 20
    points -= (lastMatchIndex - firstMatchIndex) * 0.1
    return points
  }

  return files
    .map((path) => ({ path, points: score(path) }))
    .filter((entry): entry is { path: string; points: number } => entry.points !== null)
    .sort((a, b) => b.points - a.points || a.path.localeCompare(b.path))
    .slice(0, MAX_FILE_MATCHES)
    .map((entry) => entry.path)
}
