// #101: the Pipeline strip — a status chip, one button per `port:` command,
// an inline argument row for a command that needs one, an Agents
// disclosure, and the invoke-refused banner. Built once by `view.ts` as an
// empty host element; `renderCommands` rebuilds its contents from the
// latest snapshot on every call, the same re-render-in-place idiom
// `view.ts`'s own `renderSessionChrome` already uses for the rest of the
// live screen. Every node is `createElement`/`textContent` only.
//
// State that must survive across renders — the open argument row and its
// draft text, the Agents disclosure's open state, the last invoke failure —
// lives at module scope, keyed by `sessionKey` so switching sessions drops
// it (`resetCommandsState`, called by `controller.ts` whenever
// `currentSessionKey` changes) rather than riding the main-process-owned
// snapshot.
import type { AgentSummary, CommandSummary, HostedSessionSnapshot, SessionKey } from '../../../shared/hosting/types'
import { argumentRequired, bannerCopy, chipCopy, INVOKE_REJECTED, invokeFailureCopy } from './commands-copy'

function el(tag: string, className: string, content?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (content !== undefined) node.textContent = content
  return node
}

interface OpenRow {
  readonly sessionKey: SessionKey
  readonly commandName: string
  readonly draft: string
}

let openRow: OpenRow | null = null
let agentsOpen = false
let invokeFailure: { readonly sessionKey: SessionKey; readonly text: string } | null = null
let currentHost: HTMLElement | null = null
let currentSnapshot: HostedSessionSnapshot | null = null

/** Drops every piece of state this module owns that belonged to a session
 *  which is no longer current. */
export function resetCommandsState(sessionKey: SessionKey | null): void {
  if (openRow !== null && openRow.sessionKey !== sessionKey) openRow = null
  if (invokeFailure !== null && invokeFailure.sessionKey !== sessionKey) invokeFailure = null
  agentsOpen = false
}

function currentCommand(name: string): CommandSummary | null {
  if (currentSnapshot === null) return null
  const { capabilities } = currentSnapshot
  if (capabilities.kind !== 'ready') return null
  return capabilities.commands.find((command) => command.name === name) ?? null
}

function rerender(): void {
  if (currentHost !== null && currentSnapshot !== null) renderCommands(currentHost, currentSnapshot)
}

function buildCommandButton(command: CommandSummary, disabled: boolean, midTurn: boolean): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'commands-strip__command'
  button.textContent = `/port:${command.name}`
  button.title = midTurn ? `Runs after the current turn${command.description === '' ? '' : `\n${command.description}`}` : command.description
  button.dataset.action = 'session-command-run'
  button.dataset.commandName = command.name
  button.dataset.argumentHint = command.argumentHint
  button.disabled = disabled
  return button
}

function buildArgumentRow(command: CommandSummary, draft: string): HTMLElement {
  const row = el('div', 'commands-strip__args')
  row.appendChild(el('span', 'commands-strip__args-label', `/port:${command.name}`))

  const input = document.createElement('textarea')
  input.className = 'commands-strip__args-input'
  input.rows = 1
  input.placeholder = command.argumentHint
  input.value = draft
  input.dataset.field = 'session-command-args'
  row.appendChild(input)

  if (command.description !== '') {
    const description = el('p', 'commands-strip__args-description', command.description)
    row.appendChild(description)
  }

  const actions = el('div', 'commands-strip__args-actions')
  const runButton = document.createElement('button')
  runButton.className = 'commands-strip__args-run'
  runButton.textContent = 'Run'
  runButton.dataset.action = 'session-command-args-submit'
  runButton.dataset.commandName = command.name
  runButton.disabled = argumentRequired(command.argumentHint) && draft.trim() === ''
  actions.appendChild(runButton)

  const cancelButton = document.createElement('button')
  cancelButton.className = 'commands-strip__args-cancel'
  cancelButton.textContent = 'Cancel'
  cancelButton.dataset.action = 'session-command-args-cancel'
  actions.appendChild(cancelButton)
  row.appendChild(actions)

  return row
}

function buildAgentsDisclosure(agents: readonly AgentSummary[]): HTMLElement {
  const details = document.createElement('details')
  details.className = 'commands-strip__agents'
  details.open = agentsOpen
  details.dataset.action = 'session-agents-toggle'

  const summary = document.createElement('summary')
  summary.textContent = `Agents · ${String(agents.length)}`
  details.appendChild(summary)

  for (const agent of agents) {
    const row = el('div', 'commands-strip__agent')
    const label = agent.model === null ? `port:${agent.name}` : `port:${agent.name} · ${agent.model}`
    row.appendChild(el('span', 'commands-strip__agent-name', label))
    if (agent.description !== '') row.appendChild(el('span', 'commands-strip__agent-description', agent.description))
    details.appendChild(row)
  }

  details.appendChild(
    el(
      'p',
      'commands-strip__agents-footer',
      'Stage agents are dispatched by /port:pipeline, never started from here — the labels stay the one record of who owns an item.',
    ),
  )
  return details
}

export function renderCommands(host: HTMLElement, snapshot: HostedSessionSnapshot): void {
  currentHost = host
  currentSnapshot = snapshot
  host.textContent = ''

  if (snapshot.phase === 'ended') {
    host.hidden = true
    return
  }
  host.hidden = false

  const { capabilities } = snapshot
  const chip = el('span', 'commands-strip__chip', chipCopy(capabilities))
  if (capabilities.kind === 'ready') {
    if (capabilities.plugin.kind === 'loaded' || capabilities.plugin.kind === 'shadowed') chip.title = capabilities.plugin.path
    else if (capabilities.request.source === 'repository') chip.title = capabilities.request.path
  }
  host.appendChild(chip)

  const banner = bannerCopy(capabilities)
  if (banner !== null) {
    const bannerEl = el('div', 'commands-strip__banner')
    bannerEl.setAttribute('aria-live', 'polite')
    bannerEl.appendChild(el('p', 'commands-strip__banner-text', banner.text))
    if (banner.detail !== null) {
      const pre = document.createElement('pre')
      pre.className = 'commands-strip__banner-detail'
      pre.textContent = banner.detail
      bannerEl.appendChild(pre)
    }
    host.appendChild(bannerEl)
  }

  if (invokeFailure !== null && invokeFailure.sessionKey === snapshot.sessionKey) {
    host.appendChild(el('p', 'commands-strip__invoke-failure', invokeFailure.text))
  }

  if (capabilities.kind !== 'ready') return
  if (capabilities.plugin.kind === 'missing') return // no buttons at all — the plugin never loaded

  const midTurn = snapshot.phase === 'streaming' || snapshot.phase === 'interrupting'
  const disabled = snapshot.phase === 'closing'
  if (capabilities.commands.length > 0) {
    const buttons = el('div', 'commands-strip__commands')
    for (const command of capabilities.commands) buttons.appendChild(buildCommandButton(command, disabled, midTurn))
    host.appendChild(buttons)
  }

  if (openRow !== null && openRow.sessionKey === snapshot.sessionKey) {
    const command = capabilities.commands.find((candidate) => candidate.name === openRow?.commandName)
    if (command !== undefined) host.appendChild(buildArgumentRow(command, openRow.draft))
  }

  if (capabilities.agents.length > 0) host.appendChild(buildAgentsDisclosure(capabilities.agents))
}

async function runInvocation(sessionKey: SessionKey, name: string, args: string): Promise<void> {
  try {
    const result = await window.port.sessionInvoke({ sessionKey, name, args })
    if (!result.ok) {
      invokeFailure = { sessionKey, text: invokeFailureCopy(name, result) }
    } else {
      invokeFailure = null
      if (openRow !== null && openRow.commandName === name) openRow = null
    }
  } catch (error) {
    console.error('Failed to reach the main process invoking a command', error)
    invokeFailure = { sessionKey, text: INVOKE_REJECTED }
  }
  if (currentSnapshot !== null && currentSnapshot.sessionKey === sessionKey) rerender()
}

/** `session-command-run` — an empty hint runs immediately; a non-empty one
 *  opens the inline argument row instead. */
export function handleCommandRun(target: HTMLElement, sessionKey: SessionKey): void {
  const name = target.dataset.commandName
  const hint = target.dataset.argumentHint ?? ''
  if (name === undefined) return
  if (hint === '') {
    void runInvocation(sessionKey, name, '')
    return
  }
  openRow = { sessionKey, commandName: name, draft: '' }
  rerender()
}

/** The argument textarea's own `input` handler — updates the draft and the
 *  `Run` button's disabled state in place, never a full re-render (which
 *  would steal focus from the field the operator is typing into). */
export function handleArgsInput(value: string): void {
  if (openRow === null) return
  openRow = { ...openRow, draft: value }
  if (currentHost === null) return
  const runButton = currentHost.querySelector<HTMLButtonElement>('[data-action="session-command-args-submit"]')
  if (runButton === null) return
  const command = currentCommand(openRow.commandName)
  runButton.disabled = command !== null && argumentRequired(command.argumentHint) && openRow.draft.trim() === ''
}

/** `session-command-args-submit` — the row stays open on failure (the text
 *  is not lost); it closes only once `runInvocation` sees `ok: true`. */
export function handleArgsSubmit(sessionKey: SessionKey, commandName: string, args: string): void {
  void runInvocation(sessionKey, commandName, args)
}

/** `session-command-args-cancel` and Escape. */
export function handleArgsCancel(): void {
  openRow = null
  rerender()
}

export function handleAgentsToggle(open: boolean): void {
  agentsOpen = open
}

/** The currently open argument row's own command name, `null` when none is
 *  open — `controller.ts`'s own keydown handler reads this to know which
 *  command Enter should submit. */
export function openRowCommandName(): string | null {
  return openRow?.commandName ?? null
}
