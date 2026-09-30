// The search screen (#87): a repository-scoped or all-repositories full-text
// search over local transcripts. Owns its own state and IPC round trip --
// `main.ts` only switches `view` to it, calls `openSearch` once on entry,
// and renders it via `renderSearch`, the same split `board/actions.ts` draws
// for the board's own per-item state ("main.ts delegates ... rather than
// owning this state itself"). Every node is built with
// `document.createElement`/`textContent`, never `innerHTML` -- a snippet is
// untrusted text from a transcript.
import type { RepoId } from '../../shared/repos'
import type { SearchGroup, SearchHit, SearchResult, SearchScope } from '../../shared/search/types'
import { MIN_TERM_CHARS } from '../../shared/search/types'

export type SearchScreenState =
  | { readonly status: 'idle'; readonly repoId: RepoId; readonly repoLabel: string; readonly scope: SearchScope; readonly query: string }
  | { readonly status: 'too-short'; readonly repoId: RepoId; readonly repoLabel: string; readonly scope: SearchScope; readonly query: string }
  | { readonly status: 'searching'; readonly repoId: RepoId; readonly repoLabel: string; readonly scope: SearchScope; readonly query: string }
  | { readonly status: 'unreachable'; readonly repoId: RepoId; readonly repoLabel: string; readonly scope: SearchScope; readonly query: string }
  | {
      readonly status: 'error'
      readonly repoId: RepoId
      readonly repoLabel: string
      readonly scope: SearchScope
      readonly query: string
      readonly kind: 'invalid-query' | 'sessions-unavailable'
      readonly message: string | null
    }
  | { readonly status: 'ready'; readonly repoId: RepoId; readonly repoLabel: string; readonly scope: SearchScope; readonly query: string; readonly result: Extract<SearchResult, { ok: true }> }

let state: SearchScreenState = { status: 'idle', repoId: '' as RepoId, repoLabel: '', scope: { kind: 'all' }, query: '' }
let redraw: () => void = () => {}

/** Registered once by `main.ts` -- every state change below calls this
 *  rather than main.ts polling `searchScreenState()` on a timer. */
export function registerSearchRedraw(fn: () => void): void {
  redraw = fn
}

export function searchScreenState(): SearchScreenState {
  return state
}

function setState(next: SearchScreenState): void {
  state = next
  redraw()
}

export function openSearch(repoId: RepoId, repoLabel: string): void {
  setState({ status: 'idle', repoId, repoLabel, scope: { kind: 'repo', repoId }, query: '' })
}

export function changeSearchScope(scope: SearchScope): void {
  setState({ ...state, scope })
}

export async function submitSearch(query: string): Promise<void> {
  const trimmed = query.trim()
  if (trimmed.length < MIN_TERM_CHARS) {
    setState({ status: 'too-short', repoId: state.repoId, repoLabel: state.repoLabel, scope: state.scope, query })
    return
  }

  const { repoId, repoLabel, scope } = state
  setState({ status: 'searching', repoId, repoLabel, scope, query })
  try {
    const result = await window.port.searchQuery({ query: trimmed, scope })
    if (state.status !== 'searching') return // superseded by a scope change or a second submit
    if (!result.ok) {
      setState({ status: 'error', repoId, repoLabel, scope, query, kind: result.kind, message: result.ok === false && result.kind === 'sessions-unavailable' ? result.message : null })
      return
    }
    setState({ status: 'ready', repoId, repoLabel, scope, query, result })
  } catch (error) {
    console.error('Failed to reach the main process while searching', error)
    if (state.status === 'searching') setState({ status: 'unreachable', repoId, repoLabel, scope, query })
  }
}

function text(tag: string, className: string, value: string): HTMLElement {
  const el = document.createElement(tag)
  el.className = className
  el.textContent = value
  return el
}

function buildHeader(scope: SearchScope): HTMLElement {
  const header = document.createElement('div')
  header.className = 'search-header'

  const back = document.createElement('button')
  back.className = 'search-header__back'
  back.textContent = '‹ Back'
  back.dataset.action = 'search-back'
  header.appendChild(back)

  header.appendChild(text('span', 'search-header__title', 'Search transcripts'))

  const select = document.createElement('select')
  select.className = 'search-header__scope'
  select.dataset.field = 'search-scope'
  const repoOption = document.createElement('option')
  repoOption.value = 'repo'
  repoOption.textContent = 'This repository'
  const allOption = document.createElement('option')
  allOption.value = 'all'
  allOption.textContent = 'All repositories'
  select.appendChild(repoOption)
  select.appendChild(allOption)
  select.value = scope.kind
  header.appendChild(select)

  return header
}

function buildForm(query: string): HTMLElement {
  const form = document.createElement('form')
  form.className = 'search-form'
  form.dataset.action = 'search-submit'

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'search-form__input'
  input.placeholder = 'An error, a file path, a decision'
  input.value = query
  input.dataset.field = 'search-query'
  form.appendChild(input)

  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.className = 'search-form__submit'
  submit.textContent = 'Search'
  form.appendChild(submit)

  return form
}

function kindChip(hit: SearchHit): string {
  if (hit.toolName !== null) return hit.toolName
  switch (hit.kind) {
    case 'user-text':
      return 'Prompt'
    case 'assistant-text':
      return 'Claude'
    case 'thinking':
      return 'Thinking'
    case 'meta':
      return 'System'
    case 'tool-call':
      return 'Tool'
  }
}

function buildHitRow(group: SearchGroup, hit: SearchHit): HTMLElement {
  const row = document.createElement('button')
  row.className = 'search-hit'
  row.dataset.action = 'search-hit'
  row.dataset.sessionId = group.sessionId
  row.dataset.agentId = group.agentId ?? ''
  row.dataset.entryIndex = String(hit.entryIndex)
  row.dataset.label = group.label

  const meta = document.createElement('div')
  meta.className = 'search-hit__meta'
  meta.appendChild(text('span', 'search-hit__chip', kindChip(hit)))
  meta.appendChild(text('span', 'search-hit__time', new Date(hit.timestamp).toLocaleTimeString()))
  row.appendChild(meta)

  const snippet = document.createElement('div')
  snippet.className = 'search-hit__snippet'
  const { text: snippetText, matchStart, matchLength } = hit.snippet
  snippet.appendChild(document.createTextNode(snippetText.slice(0, matchStart)))
  const mark = document.createElement('mark')
  mark.textContent = snippetText.slice(matchStart, matchStart + matchLength)
  snippet.appendChild(mark)
  snippet.appendChild(document.createTextNode(snippetText.slice(matchStart + matchLength)))
  row.appendChild(snippet)

  return row
}

function relativeTime(idleMs: number): string {
  const seconds = Math.max(0, Math.round(idleMs / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

function buildGroup(group: SearchGroup): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'search-group'

  const parts = [group.label, group.itemNumber !== null ? `#${group.itemNumber}` : null, group.agentId !== null ? 'agent' : null, relativeTime(group.idleMs), `${group.hitCount} matches`].filter(
    (part): part is string => part !== null,
  )
  wrap.appendChild(text('div', 'search-group__header', parts.join(' · ')))

  const hits = document.createElement('div')
  hits.className = 'search-group__hits'
  for (const hit of group.hits) hits.appendChild(buildHitRow(group, hit))
  wrap.appendChild(hits)

  return wrap
}

const TOO_SHORT_COPY = 'Enter at least 3 characters — shorter terms match nearly everything.'

function errorCopy(kind: 'invalid-query' | 'sessions-unavailable', message: string | null): string {
  return kind === 'sessions-unavailable' ? `Port couldn't list local sessions, so there is nothing to search: ${message ?? ''}` : TOO_SHORT_COPY
}

function buildFootnotes(result: Extract<SearchResult, { ok: true }>): readonly string[] {
  const notes: string[] = []
  if (result.unreached > 0) {
    notes.push(`${result.unreached} transcripts weren't reached before the time budget. Search again to continue — the ones just read are now indexed.`)
  }
  if (result.hitsTruncated) notes.push('Only the first 20 matches per transcript are listed.')
  if (!result.indexPersisted) notes.push("The search index couldn't be saved, so the next search will be as slow as this one.")
  return notes
}

export function renderSearch(container: HTMLElement, screenState: SearchScreenState): void {
  container.textContent = ''
  container.appendChild(buildHeader(screenState.scope))
  container.appendChild(buildForm(screenState.query))
  container.appendChild(text('p', 'search-hint', 'Terms are combined with AND and match anywhere, case-insensitively. Wrap a phrase in "quotes".'))

  if (screenState.status === 'idle') {
    container.appendChild(text('p', 'search-status', 'Port reads transcripts from this machine only. Nothing is sent anywhere.'))
    return
  }

  if (screenState.status === 'too-short') {
    container.appendChild(text('p', 'search-status search-status--error', TOO_SHORT_COPY))
    return
  }

  if (screenState.status === 'searching') {
    container.appendChild(text('p', 'search-status', 'Searching…'))
    container.appendChild(text('p', 'search-status search-status--dim', 'The first pass over a transcript reads it once and remembers it, so this is the slow one.'))
    return
  }

  if (screenState.status === 'unreachable') {
    container.appendChild(text('p', 'search-status search-status--error', 'Could not reach the main process.'))
    return
  }

  if (screenState.status === 'error') {
    container.appendChild(text('p', 'search-status search-status--error', errorCopy(screenState.kind, screenState.message)))
    return
  }

  const { result } = screenState
  if (result.groups.length === 0) {
    // A budget-bounded pass never renders as an exhaustive "no matches" --
    // `complete: false` gets its own copy rather than folding into the same
    // empty state a genuinely finished search would show.
    const emptyCopy = result.complete ? `No matches in ${result.inScope} transcripts.` : `No matches yet in ${result.read} of ${result.inScope} transcripts — the time budget ran out before the rest.`
    container.appendChild(text('p', 'search-status', emptyCopy))
  } else {
    const totalHits = result.groups.reduce((sum, group) => sum + group.hitCount, 0)
    container.appendChild(
      text(
        'p',
        'search-summary',
        `${totalHits} matches in ${result.groups.length} transcripts · ${result.skippedByIndex} skipped from the index, ${result.read} read · ${result.tookMs} ms`,
      ),
    )
    const list = document.createElement('div')
    list.className = 'search-results'
    for (const group of result.groups) list.appendChild(buildGroup(group))
    container.appendChild(list)
  }

  for (const note of buildFootnotes(result)) container.appendChild(text('p', 'search-footnote', note))
}
