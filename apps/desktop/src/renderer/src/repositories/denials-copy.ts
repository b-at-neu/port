// Every pure string the Repositories screen's Denials tab renders. Every count comes from `window`, never the whole-file `summary`.
import type { AttributionTally, SessionAttribution } from '../../../shared/local/inspect'
import type { DenialActor, DenialSummary } from '../../../shared/local/types'

export function metaStripCopy(window: DenialSummary): string {
  const hookErrorNoun = window.hookErrors === 1 ? 'hook error' : 'hook errors'
  return `${String(window.agentDenials)} denials · ${String(window.misses)} allowlist misses · ${String(window.railDenials)} rail holds · ${String(window.hookErrors)} ${hookErrorNoun}`
}

/** Shown under the meta strip only while `capped`. */
export function cappedLineCopy(analysed: number, summary: DenialSummary): string {
  const deniedWholeLog = summary.agentDenials + summary.railDenials
  return `Showing the newest ${String(analysed)} of ${String(summary.total)} log lines. Totals for the whole log: ${String(deniedWholeLog)} denials, ${String(summary.misses)} misses.`
}

/** `null` when nothing is unresolved — the row this copy feeds is omitted entirely. */
export function attributionLineCopy(tally: AttributionTally): string | null {
  const unresolved = tally.sessionUnresolved + tally.attributionUnavailable
  if (unresolved === 0) return null
  return `${String(unresolved)} entries come from sessions port couldn't identify.`
}

/** The board's own burst copy (`project.ts`) is the full sentence; this is the row pill's short form, same count and window. */
export function burstPillCopy(count: number, startedAt: string, endedAt: string): string {
  const minutes = Math.max(1, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 60_000))
  return `Burst: ${String(count)} in ${String(minutes)}m`
}

export type AttributionPillTone = 'attention' | 'idle'

export interface AttributionPill {
  readonly label: string
  readonly tone: AttributionPillTone
}

/** The by-actor row's own pill — stage agent / subagent name, an attributed session's role and label, or one of the three fallback states. `null` only when `actor` itself is `null` (a malformed line already handled by the caller). */
export function actorAttributionPill(actor: DenialActor | null, attribution: SessionAttribution | null): AttributionPill | null {
  if (actor === null) return { label: 'Unattributed', tone: 'idle' }
  switch (actor.kind) {
    case 'stage-agent':
      return { label: actor.agent, tone: 'idle' }
    case 'subagent':
      return { label: actor.agentType, tone: 'idle' }
    case 'subagent-signal':
      return { label: actor.signal, tone: 'idle' }
    case 'unattributed':
      return { label: 'Unattributed', tone: 'idle' }
    case 'session':
      if (attribution === null) return { label: 'Unattributed', tone: 'idle' }
      switch (attribution.kind) {
        case 'attributed':
          return { label: `${attribution.role}${attribution.label !== null ? ` · ${attribution.label}` : ''}`, tone: 'idle' }
        case 'unknown-session':
          return { label: 'Unknown session', tone: 'attention' }
        case 'attribution-unavailable':
          return { label: attribution.reason === 'not-scanned' ? 'Sessions not scanned' : 'Session scan failed', tone: 'idle' }
      }
  }
}

export function emptyLogCopy(): string {
  return 'No denial log yet. The guard hook writes .agents/denials.log the first time it records a decision.'
}

export function noEntriesCopy(): string {
  return 'The denial log is empty.'
}

export function readFailedCopy(path: string, message: string): string {
  return `Couldn't read the denial log at ${path}: ${message}.`
}
