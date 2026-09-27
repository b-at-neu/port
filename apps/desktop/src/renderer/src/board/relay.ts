// The relay loop's own header line, banner, and compose form (#107) — pure
// copy functions plus the banner's DOM, one `switch` per union member (the
// same rule `board/tick.ts`/`board/copy.ts` already state, so a new
// `RelayKind` is a compile error here rather than a silently blank line).
// Avoids `running`/`alive`/`isLive` entirely — already banned under
// `renderer/src/board/`.
import type { RepoId } from '../../../shared/repos'
import type { PortStageAgent } from '../../../shared/sessions/types'
import { composeReply } from '../../../shared/relay/compose'
import type { RelayPending, RelayScan } from '../../../shared/relay/types'

/** Keyed by `sessionId#agentId` — exported so `main.ts` can resolve the
 *  `RelayPending` a click's `dataset.key` refers to, from the snapshot's own
 *  `relay.pending`, rather than this module holding a second copy of the
 *  identity it did not compute. */
export function relayKeyOf(pending: Pick<RelayPending, 'sessionId' | 'agentId'>): string {
  return `${pending.sessionId}#${pending.agentId ?? ''}`
}

function answerCountFor(pending: RelayPending): number {
  return pending.kind === 'questions' ? pending.questions.length : 1
}

/** Per-pending UI state, held here rather than in `main.ts` (the same split
 *  `board/actions.ts` draws for the action controller) — expanded/collapsed,
 *  the answer text per question (or the single decision text for
 *  `blocked`), and a transient "just copied" flag. Keyed by
 *  `sessionId#agentId`, so a rebuild never loses what the operator already
 *  typed. */
const expanded = new Set<string>()
const answers = new Map<string, string[]>()
const justCopied = new Set<string>()

export function isRelayExpanded(pending: RelayPending): boolean {
  return expanded.has(relayKeyOf(pending))
}

export function toggleRelayExpanded(pending: RelayPending): void {
  const key = relayKeyOf(pending)
  if (expanded.has(key)) expanded.delete(key)
  else expanded.add(key)
}

function answersFor(pending: RelayPending): string[] {
  const key = relayKeyOf(pending)
  const existing = answers.get(key)
  if (existing !== undefined && existing.length === answerCountFor(pending)) return existing
  const fresh = new Array<string>(answerCountFor(pending)).fill('')
  answers.set(key, fresh)
  return fresh
}

export function relayAnswer(pending: RelayPending, index: number): string {
  return answersFor(pending)[index] ?? ''
}

export function setRelayAnswer(pending: RelayPending, index: number, value: string): void {
  const current = answersFor(pending).slice()
  current[index] = value
  answers.set(relayKeyOf(pending), current)
}

/** Evicts every per-pending state whose relay is no longer on the board —
 *  answered, or the agent moved past it — since without this the maps only
 *  ever grow for the renderer's whole life (the same rule
 *  `board/actions.ts`'s own `pruneItemActionStates` follows). Call once per
 *  fresh snapshot, never per render. */
export function pruneRelayStates(scan: RelayScan): void {
  const live = new Set(scan.ok ? scan.pending.map((p) => relayKeyOf(p)) : [])
  for (const key of [...expanded, ...answers.keys(), ...justCopied]) {
    if (!live.has(key)) {
      expanded.delete(key)
      answers.delete(key)
      justCopied.delete(key)
    }
  }
}

/** A fingerprint of every per-pending state this module holds, folded into
 *  the board's own no-op guard the same way `board/actions.ts`'s
 *  `actionsFingerprint` is — none of this state lives on the projection
 *  itself, so without it a toggle or a keystroke would never repaint. */
export function relayFingerprint(): string {
  return JSON.stringify([[...expanded].sort(), [...answers.entries()].sort(), [...justCopied].sort()])
}

export async function handleRelayCopy(pending: RelayPending, redraw: () => void): Promise<void> {
  const text = composeReply(pending, answersFor(pending))
  if (text === null) return
  try {
    const result = await window.port.relayCopy({ text })
    if (result.ok) {
      justCopied.add(relayKeyOf(pending))
      redraw()
      setTimeout(() => {
        justCopied.delete(relayKeyOf(pending))
        redraw()
      }, 1500)
    }
  } catch (error) {
    console.error('Failed to copy the relay reply', error)
  }
}

/** `plan-agent` → `plan`, etc. — the banner's own short form, never the bare
 *  `PortStageAgent` string. */
function shortStage(stage: PortStageAgent): string {
  return stage.replace(/-agent$/, '')
}

function minutesWaiting(lastActivityAt: string, now: Date): number {
  return Math.max(1, Math.round((now.getTime() - Date.parse(lastActivityAt)) / 60_000))
}

function labelOf(pending: RelayPending): string {
  return pending.number !== null ? `#${String(pending.number)}` : 'this item'
}

/** The header line — never `''`. A zero-checked scan (a ready repository
 *  with no dispatched stage agents at all) is written out the same as any
 *  other "nothing waiting" case, never silence (ENGINEERING §4: an absent
 *  signal is never read as a passing one). Only the caller (`view.ts`)
 *  withholds the line entirely, before the first snapshot lands. */
export function relayLineCopy(scan: RelayScan): string {
  if (!scan.ok) return "Relay: can't read agent transcripts, so a waiting agent would be invisible here."

  const { pending, checked, unreached } = scan
  if (pending.length > 0) return `Relay: ${String(pending.length)} waiting on you.`
  if (unreached > 0) {
    return `Relay: nothing waiting (${String(checked)} checked, ${String(unreached)} transcript${unreached === 1 ? '' : 's'} unreadable — can't tell whether it's waiting).`
  }
  return `Relay: nothing waiting (${String(checked)} agent${checked === 1 ? '' : 's'} checked).`
}

export function entryLineCopy(pending: RelayPending, repoName: string, now: Date): string {
  const waiting = minutesWaiting(pending.lastActivityAt, now)
  const head = `${shortStage(pending.stage)} ${labelOf(pending)} · ${repoName}`
  switch (pending.kind) {
    case 'questions': {
      const n = pending.questions.length
      return `${head} — ${String(n)} question${n === 1 ? '' : 's'}, waiting ${String(waiting)}m`
    }
    case 'blocked':
      return `${head} — blocked, waiting ${String(waiting)}m`
    case 'usage-limit':
      return `${head} — hit the session limit, ${String(waiting)}m ago. Nothing moves until the window resets.`
  }
}

function el(tag: string, className: string, content?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (content !== undefined) node.textContent = content
  return node
}

function buildComposeForm(pending: RelayPending): HTMLElement | null {
  if (pending.kind === 'usage-limit') return null

  const form = el('div', 'relay-banner__form')
  const key = relayKeyOf(pending)

  if (pending.kind === 'questions') {
    pending.questions.forEach((question, index) => {
      form.appendChild(el('div', 'relay-banner__question', `${String(index + 1)}. ${question.text}`))
      const textarea = document.createElement('textarea')
      textarea.className = 'relay-banner__answer'
      textarea.dataset.key = key
      textarea.dataset.index = String(index)
      textarea.value = relayAnswer(pending, index)
      form.appendChild(textarea)
    })
  } else {
    form.appendChild(el('div', 'relay-banner__question', pending.request))
    form.appendChild(el('div', 'relay-banner__hint', 'Your decision'))
    const textarea = document.createElement('textarea')
    textarea.className = 'relay-banner__answer'
    textarea.dataset.key = key
    textarea.dataset.index = '0'
    textarea.value = relayAnswer(pending, 0)
    form.appendChild(textarea)
  }

  const composed = composeReply(pending, answersFor(pending))
  const footer = el('div', 'relay-banner__footer')
  const copyButton = document.createElement('button')
  copyButton.className = 'relay-banner__copy'
  copyButton.dataset.action = 'relay-copy'
  copyButton.dataset.key = key
  copyButton.disabled = composed === null
  const copied = justCopied.has(key)
  copyButton.textContent = copied ? 'Copied' : pending.kind === 'questions' ? 'Copy answers' : 'Copy decision'
  footer.appendChild(copyButton)
  if (composed === null && pending.kind === 'questions') {
    const total = pending.questions.length
    footer.appendChild(el('span', 'relay-banner__incomplete', `Answer all ${String(total)} to copy.`))
  }
  form.appendChild(footer)
  form.appendChild(el('div', 'relay-banner__footnote', `Paste into the session that dispatched this agent: "${pending.parentSessionLabel}".`))

  return form
}

function buildEntry(pending: RelayPending, repoName: string, now: Date): HTMLElement {
  const entry = el('div', 'relay-banner__entry')
  const header = el('div', 'relay-banner__entry-header', entryLineCopy(pending, repoName, now))
  header.dataset.action = 'relay-toggle'
  header.dataset.key = relayKeyOf(pending)
  entry.appendChild(header)

  if (isRelayExpanded(pending)) {
    const form = buildComposeForm(pending)
    if (form !== null) entry.appendChild(form)
  }

  return entry
}

/** `null` when `relays` is empty — rendered above the groups, only then
 *  (`view.ts`'s own call site), the same "absent, not disabled" rule
 *  `board/view.ts`'s ungated section already follows. */
export function buildRelayBanner(relays: readonly RelayPending[], repoNameOf: (repoId: RepoId | null) => string, now: Date): HTMLElement | null {
  if (relays.length === 0) return null
  const banner = el('div', 'relay-banner')
  banner.appendChild(el('div', 'relay-banner__heading', `Waiting on you · ${String(relays.length)}`))
  for (const pending of relays) banner.appendChild(buildEntry(pending, repoNameOf(pending.repoId), now))
  return banner
}
