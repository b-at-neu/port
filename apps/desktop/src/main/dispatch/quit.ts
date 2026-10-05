// #326: the quit warning's own pure copy and guard — no electron import, so
// this is testable without a real window. `main/dialogs.ts` is the one
// caller that turns `quitWarningCopy`'s result into a native message box.
import type { StageAgent } from '../../shared/tick/types'
import type { LabelKey } from '../../shared/labels/vocabulary'

/** One live stage session, as the quit guard needs it — `repoName` is the
 *  display name (`owner/name`), never a `RepoId`, since the copy below
 *  prints it verbatim. */
export interface StageSessionSummary {
  readonly agent: StageAgent
  readonly number: number
  readonly trigger: LabelKey
  readonly repoName: string
}

/** DESIGN §6's own role display names, lowercased for inline use —
 *  `refreshing` when the trigger is `refreshBranch`, regardless of agent,
 *  since a refresh dispatch is always the impl agent working in refresh
 *  mode. */
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

/** `null` for an empty list — the caller never shows a dialog then. Sessions
 *  sort by repo, then number. */
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
  /** Resolves `true` on confirm, `false` on cancel — a rejection is logged
   *  and treated as confirm (fails open toward the operator's explicit
   *  quit: a broken dialog must never trap the app). */
  readonly confirm: (copy: QuitWarningCopy) => Promise<boolean>
  readonly quit: () => void
}

export interface QuitGuard {
  /** `true` when the quit was intercepted (the caller must call
   *  `preventDefault` itself and pass it in) — `false` means the quit may
   *  proceed immediately. */
  intercept(preventDefault: () => void): boolean
}

/** Already confirmed, or no live stage sessions → `false`. A prompt already
 *  open → prevent, `true`, no second dialog. Otherwise prevent and prompt;
 *  confirm marks confirmed and calls `quit()`, cancel does nothing. */
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
