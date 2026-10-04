// The runtime strip (#97) — a single status line above the nav, always
// visible, owning its own state and its own click listener, the same
// self-contained-module shape `claim/controller.ts`'s `initClaim` already
// uses. `main.ts` gains only the import and the `initRuntime(container)`
// call. Every node is built with `createElement`/`textContent` —
// `desktop-renderer` denies every HTML-injection sink.
import type { RepoId } from '../../shared/repos'
import type { RuntimePreflight, RuntimeProbe } from '../../shared/runtime/types'
import {
  CLI_OUTDATED_COPY,
  RUNTIME_API_KEY_NOTE,
  RUNTIME_COPY,
  RUNTIME_NO_READY_REPO_NOTE,
  RUNTIME_PROBE_ERROR,
  RUNTIME_STRIP_ERROR,
  RUNTIME_STRIP_LOADING,
  RUNTIME_UNVERIFIED_STRIP_NOTE,
  runtimeActionLabel,
} from '../../shared/runtime/copy'

interface ReadyRepo {
  readonly id: RepoId
  readonly repo: string
}

type RuntimeStripState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly preflight: RuntimePreflight; readonly repo: ReadyRepo | null; readonly probing: boolean; readonly probe: RuntimeProbe | null; readonly probeError: boolean }

let state: RuntimeStripState = { status: 'loading' }
let strip: HTMLElement | null = null
let text: HTMLElement | null = null

function appendLine(className: string, value: string): void {
  if (!text) return
  const el = document.createElement('div')
  el.className = className
  el.textContent = value
  text.append(el)
}

function draw(): void {
  if (!strip || !text) return
  text.textContent = ''
  const existingButton = strip.querySelector('.runtime-strip__action')
  existingButton?.remove()

  if (state.status === 'loading') {
    appendLine('runtime-strip__line', RUNTIME_STRIP_LOADING)
    return
  }
  if (state.status === 'error') {
    appendLine('runtime-strip__line', RUNTIME_STRIP_ERROR)
    return
  }

  const { preflight, repo, probing, probe, probeError } = state
  const diagnosis = probe?.diagnosis ?? preflight.diagnosis
  const copy = RUNTIME_COPY[diagnosis]
  const detail = probe?.detail ?? preflight.detail
  const versionSuffix = preflight.version !== null && preflight.version.raw !== null ? ` ${preflight.version.raw}` : ''

  if (probeError) {
    appendLine('runtime-strip__line', RUNTIME_PROBE_ERROR)
  }

  if (diagnosis === 'unverified' && preflight.executable !== null) {
    appendLine('runtime-strip__line', `Claude Code${versionSuffix} · ${preflight.executable.path}`)
    appendLine('runtime-strip__sub', RUNTIME_UNVERIFIED_STRIP_NOTE)
  } else if (diagnosis === 'verified' && probe !== null) {
    appendLine('runtime-strip__line', `Claude Code${versionSuffix} · verified against ${probe.repo} in ${(probe.elapsedMs / 1000).toFixed(1)}s`)
    if (probe.apiKeyInEnvironment) {
      appendLine('runtime-strip__sub', RUNTIME_API_KEY_NOTE)
    }
  } else {
    appendLine('runtime-strip__line', copy.title)
    appendLine('runtime-strip__sub', detail !== null ? `${copy.body} ${detail}` : copy.body)
  }

  if (preflight.version !== null && preflight.version.belowMinimum) {
    appendLine('runtime-strip__sub', CLI_OUTDATED_COPY.title)
  }

  const label = runtimeActionLabel(diagnosis)
  if (label === null) return

  // The one disabling case the UX spec names: 'Test connection' with no
  // ready repository to test against. Every other diagnosis's 'Retry'
  // still works with no repository registered — it just re-runs the cheap
  // preflight rather than a probe (`handleAction`'s own branch).
  const disabledForNoRepo = diagnosis === 'unverified' && repo === null
  if (disabledForNoRepo) appendLine('runtime-strip__sub', RUNTIME_NO_READY_REPO_NOTE)

  const button = document.createElement('button')
  button.className = 'runtime-strip__action'
  button.dataset.action = 'runtime-retry'
  button.disabled = probing || disabledForNoRepo
  button.textContent = probing ? 'Testing…' : label
  strip.append(button)
}

async function loadReadyRepo(): Promise<ReadyRepo | null> {
  const result = await window.port.reposList()
  if (!result.ok) return null
  for (const entry of result.repositories) {
    if ('config' in entry) return { id: entry.id, repo: entry.config.repo }
  }
  return null
}

async function refreshPreflight(): Promise<void> {
  try {
    const [preflight, repo] = await Promise.all([window.port.runtimePreflight(), loadReadyRepo()])
    state = { status: 'ready', preflight, repo, probing: false, probe: null, probeError: false }
  } catch (error) {
    console.error('Failed to reach the main process while checking the runtime', error)
    state = { status: 'error' }
  }
  draw()
}

async function runProbe(): Promise<void> {
  if (state.status !== 'ready' || state.repo === null || state.probing) return
  const repoId = state.repo.id
  state = { ...state, probing: true, probeError: false }
  draw()
  try {
    const probe = await window.port.runtimeProbe({ repoId })
    if (state.status === 'ready') state = { ...state, probing: false, probe, probeError: false }
  } catch (error) {
    console.error('Failed to reach the main process while testing the connection', error)
    if (state.status === 'ready') state = { ...state, probing: false, probeError: true }
  }
  draw()
}

function handleAction(): void {
  if (state.status !== 'ready') return
  if (state.repo !== null) void runProbe()
  else void refreshPreflight()
}

/** Appended once to `#runtime-strip`, above the nav — never re-created on a
 *  board tick or a repositories refresh, since nothing here re-renders on
 *  either. */
export function initRuntime(container: HTMLElement): void {
  strip = document.createElement('div')
  strip.className = 'runtime-strip'
  text = document.createElement('div')
  text.className = 'runtime-strip__text'
  strip.append(text)
  container.append(strip)
  draw()
  void refreshPreflight()

  strip.addEventListener('click', (event) => {
    const target = event.target
    if (target instanceof HTMLElement && target.dataset.action === 'runtime-retry') handleAction()
  })
}
