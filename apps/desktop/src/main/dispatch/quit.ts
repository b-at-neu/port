// The quit warning's own pure copy and guard — no electron import.
import type { StageAgent } from '../../shared/tick/types'
import type { LabelKey } from '../../shared/labels/vocabulary'

// One live stage session, as the quit guard needs it — `repoName` is the
// display name (`owner/name`), printed verbatim by the copy below.
export interface StageSessionSummary {
  readonly agent: StageAgent
  readonly number: number
  readonly trigger: LabelKey
  readonly repoName: string
}

// `refreshing` when the trigger is `refreshBranch`, regardless of agent.
export function stagePhaseName(agent: StageAgent, trigger: LabelKey): string {
  if (trigger === 'refreshBranch') return 'refreshing'
  switch (agent) {
    case 'plan':
      return 'planning'
    case 'impl':
      return 'implementing'
    case 'review':
      return 'reviewing'
    case 'revise':
      return 'revising'
  }
}

export interface QuitWarningCopy {
  readonly message: string
  readonly detail: string
  readonly confirmLabel: string
  readonly cancelLabel: string
}

function sortKey(s: StageSessionSummary): string {
  return `${s.repoName}#${String(s.number).padStart(10, '0')}`
}

// `null` for an empty list — the caller never shows a dialog then.
export function quitWarningCopy(sessions: readonly StageSessionSummary[]): QuitWarningCopy | null {
  if (sessions.length === 0) return null
  const sorted = [...sessions].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
  const plural = sessions.length !== 1

  const message = plural ? `Quit port and stop ${String(sessions.length)} stage sessions?` : 'Quit port and stop 1 stage session?'
  const lines = sorted.map((s) => `#${String(s.number)} ${stagePhaseName(s.agent, s.trigger)} · ${s.repoName}`)
  const closing = plural
    ? 'Quitting interrupts them where they are. Their tickets keep their current labels.'
    : 'Quitting interrupts it where it is. Its ticket keeps its current label.'
  const detail = `${lines.join('\n')}\n\n${closing}`

  return { message, detail, confirmLabel: plural ? 'Stop sessions and quit' : 'Stop session and quit', cancelLabel: 'Cancel' }
}

export interface CreateQuitGuardParams {
  readonly sessions: () => readonly StageSessionSummary[]
  // Resolves true on confirm, false on cancel — a rejection fails open (treated as confirm).
  readonly confirm: (copy: QuitWarningCopy) => Promise<boolean>
  readonly quit: () => void
}

export interface QuitGuard {
  // true when the quit was intercepted; the caller must itself call preventDefault.
  intercept(preventDefault: () => void): boolean
}

// Already confirmed or no live sessions: false. A prompt already open: prevent, no second dialog.
export function createQuitGuard(params: CreateQuitGuardParams): QuitGuard {
  let confirmed = false
  let prompting = false

  function intercept(preventDefault: () => void): boolean {
    if (confirmed) return false
    const sessions = params.sessions()
    if (sessions.length === 0) return false
    if (prompting) {
      preventDefault()
      return true
    }
    preventDefault()
    prompting = true
    const copy = quitWarningCopy(sessions)
    if (copy === null) {
      prompting = false
      return true
    }
    void params
      .confirm(copy)
      .catch((error: unknown) => {
        console.error('[dispatch] quit confirm dialog failed — failing open toward quit', error)
        return true
      })
      .then((confirmResult) => {
        prompting = false
        if (confirmResult) {
          confirmed = true
          params.quit()
        }
      })
    return true
  }

  return { intercept }
}
