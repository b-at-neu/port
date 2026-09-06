// The per-repository worktrees section (#86): collapsed until asked, one
// `report --json` run per Inspect/Refresh click, never a poll (Decision 5).
// Every node is built with `document.createElement`/`textContent`, never
// `innerHTML` — a worktree's `reason` string arrives verbatim from the
// reclamation script's stdout (Decision 4's "passed through, never
// re-summarised"). All of this ticket's UX copy lives here, in one `switch`
// per union, so a new report kind is a compile error rather than a silently
// blank row.
import type { RepoId } from '../../shared/repos'
import type { InspectedWorktree, WorktreesReport } from '../../shared/reclaimer/types'

export type WorktreeSectionState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'done'; readonly report: WorktreesReport }

function text(tag: string, className: string, value: string): HTMLElement {
  const el = document.createElement(tag)
  el.className = className
  el.textContent = value
  return el
}

function button(label: string, action: string, repoId: RepoId, disabled: boolean): HTMLElement {
  const el = document.createElement('button')
  el.className = 'worktrees__button'
  el.textContent = label
  el.dataset.action = action
  el.dataset.repoId = repoId
  el.disabled = disabled
  return el
}

/** One line per kind, naming what was refused — the plan's own **UX
 *  states** copy, verbatim where the plan gives an exact sentence. */
function failureCopy(failure: Extract<WorktreesReport, { ok: false }>): string {
  switch (failure.kind) {
    case 'not-configured':
      return 'No `commands.worktrees` in this repository’s config, so worktree hygiene is unavailable. Run /port:init in it to install the reclamation script.'
    case 'unsupported-runner':
      return `\`commands.worktrees\` starts with \`${failure.token}\`, which Port won’t run — only a \`node\` prefix is supported.`
    case 'unparseable-command':
      return '`commands.worktrees` could not be parsed as a plain command — it may contain a shell metacharacter or an unbalanced quote. Nothing was run.'
    case 'not-found':
      return "Node.js wasn't found. Set `PORT_NODE_PATH` if it's installed somewhere unusual."
    case 'cwd-missing':
      return "This repository's working directory couldn't be found on disk."
    case 'script-failed':
      return `The reclamation script reported: \`${failure.message}\`.`
    case 'report-unparseable':
      return "The script's output wasn't the expected JSON."
    case 'timeout':
      return 'Timed out after 60s.'
    case 'signalled':
      return 'The reclamation script was killed before it finished.'
    case 'output-too-large':
      return "The reclamation script's output was too large to read."
    case 'nonzero':
      return `The reclamation script exited with an error: ${failure.message}`
    case 'spawn-failed':
      return `Couldn't run Node.js: ${failure.message}`
  }
}

function producerCopy(producer: InspectedWorktree['producer']): string | null {
  if (producer === 'operator') return 'operator session'
  if (producer === 'dispatched') return 'dispatched agent'
  return null
}

function buildRow(worktree: InspectedWorktree): HTMLElement {
  const row = document.createElement('div')
  row.className = 'worktree-row'

  const headline = document.createElement('div')
  headline.className = 'worktree-row__headline'
  headline.appendChild(text('span', 'worktree-row__name', worktree.pathBasename))
  headline.appendChild(text('span', `worktree-row__chip worktree-row__chip--${worktree.state}`, worktree.state))
  if (worktree.branch !== null) headline.appendChild(text('span', 'worktree-row__branch', worktree.branch))
  if (worktree.issue !== null) headline.appendChild(text('span', 'worktree-row__issue', `#${worktree.issue} (${worktree.rung ?? ''})`))
  row.appendChild(headline)

  row.appendChild(text('div', 'worktree-row__reason', worktree.reason))

  if (worktree.prunable === true) {
    row.appendChild(text('div', 'worktree-row__note', 'Its directory is gone. `git worktree prune` clears the registration.'))
  }
  const producer = producerCopy(worktree.producer)
  if (producer !== null) row.appendChild(text('div', 'worktree-row__note', producer))

  return row
}

function needsAttentionCount(worktrees: readonly InspectedWorktree[]): number {
  return worktrees.filter((w) => !w.reclaimable && (w.state === 'locked' || w.state === 'dirty' || w.state === 'unresolved')).length
}

function buildReady(report: Extract<WorktreesReport, { ok: true }>, repoId: RepoId): HTMLElement {
  const section = document.createElement('div')
  section.className = 'worktrees__body'

  if (report.githubResolution === 'unavailable') {
    section.appendChild(
      text(
        'div',
        'worktrees__banner',
        "GitHub couldn't be reached, so a finished worktree can't be told from an unresolved one. Only worktrees with nothing to lose are shown as reclaimable.",
      ),
    )
  }
  if (report.porcelainJoin === 'unavailable') {
    section.appendChild(
      text('div', 'worktrees__banner', "Couldn't read this repository's worktree list directly, so a registered-but-missing directory isn't flagged."),
    )
  }

  const reclaimableCount = report.worktrees.filter((w) => w.reclaimable).length
  section.appendChild(
    text('div', 'worktrees__summary', `${report.registered} registered · ${reclaimableCount} reclaimable · ${needsAttentionCount(report.worktrees)} need attention`),
  )

  const meta = document.createElement('div')
  meta.className = 'worktrees__meta'
  meta.appendChild(text('span', 'worktrees__checked', `Checked ${new Date(report.readAt).toLocaleTimeString()}`))
  meta.appendChild(button('Refresh', 'inspect-worktrees', repoId, false))
  section.appendChild(meta)

  if (report.worktrees.length === 0) {
    section.appendChild(text('p', 'worktrees__empty', 'No linked worktrees. Only the main checkout is registered.'))
  } else {
    const rows = document.createElement('div')
    rows.className = 'worktree-rows'
    for (const worktree of report.worktrees) rows.appendChild(buildRow(worktree))
    section.appendChild(rows)
  }

  if (report.orphanDirs.length > 0) {
    const block = document.createElement('div')
    block.className = 'worktrees__orphans'
    block.appendChild(
      text('p', 'worktrees__orphans-title', `${report.orphanDirs.length} untracked directory(ies) sit beside a registered worktree. \`git worktree prune\` can't clear these.`),
    )
    for (const dir of report.orphanDirs) block.appendChild(text('p', 'worktrees__orphan-path', dir))
    section.appendChild(block)
  }

  section.appendChild(text('p', 'worktrees__reclaim-note', "Reclaiming removes directories, and Port doesn't write yet. Run /port:worktree-clean in this repository."))

  return section
}

function buildHeader(title: string, action: HTMLElement | null): HTMLElement {
  const header = document.createElement('div')
  header.className = 'worktrees__header'
  header.appendChild(text('span', 'worktrees__title', title))
  if (action) header.appendChild(action)
  return header
}

export function buildWorktreesSection(commandsWorktrees: string | null, repoId: RepoId, state: WorktreeSectionState): HTMLElement {
  const section = document.createElement('div')
  section.className = 'worktrees'

  if (commandsWorktrees === null) {
    section.appendChild(buildHeader('Worktrees', null))
    section.appendChild(
      text(
        'p',
        'worktrees__banner',
        'No `commands.worktrees` in this repository’s config, so worktree hygiene is unavailable. Run /port:init in it to install the reclamation script.',
      ),
    )
    return section
  }

  if (state.status === 'idle') {
    section.appendChild(buildHeader('Worktrees', button('Inspect', 'inspect-worktrees', repoId, false)))
    return section
  }

  if (state.status === 'loading') {
    section.appendChild(buildHeader('Worktrees', button('Inspecting…', 'inspect-worktrees', repoId, true)))
    return section
  }

  const report = state.report
  if (!report.ok) {
    section.appendChild(buildHeader('Worktrees', button('Inspect', 'inspect-worktrees', repoId, false)))
    section.appendChild(text('p', 'worktrees__banner', failureCopy(report)))
    return section
  }

  section.appendChild(buildHeader('Worktrees', null))
  section.appendChild(buildReady(report, repoId))
  return section
}
