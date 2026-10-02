// The dispatch-ownership line (#265) — one per ready repository, rendered
// under its own tick line (`view.ts`). Pure copy plus the line's own DOM;
// `main.ts` routes the Take/Release button's click to `window.port.
// dispatchClaimSet` through `board/dispatch.ts`'s `handleDispatchClick`, the
// same split every other board control already follows.
import type { DispatcherState, RepoDispatchStatus } from '../../../shared/dispatch/types'

function timeOf(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function activeLine(state: Extract<DispatcherState, { readonly kind: 'active' }>, claimedAt: string | null): string {
  const live = state.recent.filter((r) => r.state === 'sent' || r.state === 'started')
  if (live.length === 0) {
    const claimedPart = claimedAt !== null ? ` · claimed ${timeOf(claimedAt)}` : ''
    return `▶ Dispatch: this app${claimedPart} · nothing to dispatch.`
  }
  const newest = live.reduce((a, b) => (Date.parse(a.at) > Date.parse(b.at) ? a : b))
  const named = live.map((r) => `${r.agent} #${String(r.number)}`).join(', ')
  return `▶ Dispatch: this app · started ${named} at ${timeOf(newest.at)}.`
}

/** Exhaustive over `DispatchOwner` × `DispatcherState` (plan's own **UX
 *  states**) — a new member of either is a compile error here, never a
 *  silently blank line. `owner !== 'app'` never reads `status.state` at
 *  all, since only this app's own dispatcher ever has anything there. */
export function ownerLineCopy(status: RepoDispatchStatus): string {
  if (status.owner === 'nobody') {
    return "⛔ Dispatch: nobody — .agents/gate-claim.json can't be read. This app and the cockpit both stand down. Fix or delete the file."
  }
  if (status.owner === 'cockpit') {
    return 'Dispatch: your terminal cockpit dispatches here. This app only reports what it would dispatch.'
  }

  // owner === 'app'
  const state = status.state
  switch (state.kind) {
    case 'idle':
      return activeLine({ kind: 'active', recent: [] }, status.claimedAt)
    case 'active':
      return activeLine(state, status.claimedAt)
    case 'refused':
      return "⏸ Dispatch: this app, but not dispatching — commands.budget is set, and this app can't enforce a budget yet. Release dispatch to hand it back to the cockpit."
    case 'dispatcher-failed':
      if (state.reason === 'at-capacity') {
        return `⚠ Dispatch: this app couldn't start its dispatcher — ${String(state.limit)} hosted sessions are already open, the limit. Close one and dispatch resumes on the next poll.`
      }
      if (state.reason === 'plugin') {
        return "⚠ Dispatch: the dispatcher's port plugin didn't load (missing). Nothing dispatches until it does."
      }
      return "⚠ Dispatch: the dispatcher's session failed to start. Nothing dispatches until it recovers."
    case 'agents-missing':
      return `⚠ Dispatch: the dispatcher has no port:${state.agent}-agent — Claude Code dropped it. Dispatch waits.`
  }
}

/** The button's own label and action — `null` for `nobody` (no control at
 *  all, per the plan's own UX table). */
function controlFor(status: RepoDispatchStatus): { readonly label: string; readonly action: 'dispatch-claim-take' | 'dispatch-claim-release'; readonly title: string } | null {
  if (status.owner === 'nobody') return null
  if (status.owner === 'cockpit') {
    return { label: 'Take dispatch', action: 'dispatch-claim-take', title: 'Stops a /port:pipeline cockpit in this checkout from dispatching.' }
  }
  return { label: 'Release dispatch', action: 'dispatch-claim-release', title: 'Hands dispatch back to a /port:pipeline cockpit in this checkout.' }
}

/** One repository's own owner line plus its Take/Release control — `view.ts`
 *  renders this directly under that repository's tick line. The control
 *  carries `data-repo-id` so `board/dispatch.ts`'s `handleDispatchClick` can
 *  resolve which repository a click names without a second lookup. */
export function buildOwnerLine(status: RepoDispatchStatus): HTMLElement {
  const line = document.createElement('div')
  line.className = 'board-header__owner-line'

  const text = document.createElement('span')
  text.className = 'board-header__owner-text'
  text.textContent = ownerLineCopy(status) + (status.draining ? ' · draining' : '')
  line.appendChild(text)

  const control = controlFor(status)
  if (control !== null) {
    const button = document.createElement('button')
    button.className = 'board-header__owner-button'
    button.dataset.action = control.action
    button.dataset.repoId = String(status.repoId)
    button.title = control.title
    button.textContent = control.label
    line.appendChild(button)
  }

  return line
}
